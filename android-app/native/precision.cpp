#include <jni.h>
#include <llama.h>
#include <algorithm>
#include <atomic>
#include <cstdio>
#include <iterator>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef __ANDROID__
#include <unistd.h>
#endif

namespace {
constexpr int context_size = 3072;
constexpr int batch_size = 384;
constexpr int output_limit = 1024;
std::once_flag backend;

struct Engine {
    std::unique_ptr<llama_model, decltype(&llama_model_free)> model{nullptr, llama_model_free};
    std::unique_ptr<llama_context, decltype(&llama_free)> context{nullptr, llama_free};
    std::atomic<bool> cancelled{false};
    std::vector<llama_token> last_prompt;
};

jmethodID callback_method(JNIEnv *env, jobject callback, const char *name, const char *signature) {
    if (!callback) return nullptr;
    jclass type = env->GetObjectClass(callback);
    if (!type) throw std::runtime_error("Unable to access the progress callback.");
    jmethodID method = env->GetMethodID(type, name, signature);
    env->DeleteLocalRef(type);
    if (!method) throw std::runtime_error("Unable to access the progress callback.");
    return method;
}

struct LoadProgress {
    JNIEnv *env;
    jobject callback;
    jmethodID test;

    static bool report(float fraction, void *data) {
        auto &progress = *static_cast<LoadProgress *>(data);
        const int percent = static_cast<int>(std::clamp(fraction, 0.0f, 1.0f) * 100);
        const auto proceed = progress.env->CallBooleanMethod(progress.callback, progress.test, percent);
        return proceed && !progress.env->ExceptionCheck();
    }
};

std::string from_bytes(JNIEnv *env, jbyteArray value) {
    if (!value) throw std::runtime_error("Missing input.");
    std::string bytes(env->GetArrayLength(value), '\0');
    env->GetByteArrayRegion(value, 0, static_cast<jsize>(bytes.size()), reinterpret_cast<jbyte *>(bytes.data()));
    return bytes;
}

void fail(JNIEnv *env, const char *message) {
    if (!env->ExceptionCheck()) env->ThrowNew(env->FindClass("java/io/IOException"), message);
}

std::string format_prompt(const llama_model *model, const std::string &prompt) {
    llama_chat_message message{"user", prompt.c_str()};
    const char *templ = llama_model_chat_template(model, nullptr);
    if (!templ) templ = "hunyuan-dense";
    std::vector<char> formatted(prompt.size() + 512);
    int size = llama_chat_apply_template(templ, &message, 1, true, formatted.data(), formatted.size());
    if (size < 0) {
        templ = "hunyuan-dense";
        size = llama_chat_apply_template(templ, &message, 1, true, formatted.data(), formatted.size());
    }
    if (size < 0) throw std::runtime_error("The model chat template is unsupported.");
    if (static_cast<size_t>(size) >= formatted.size()) {
        formatted.resize(size + 1);
        size = llama_chat_apply_template(templ, &message, 1, true, formatted.data(), formatted.size());
    }
    if (size <= 0 || static_cast<size_t>(size) >= formatted.size()) {
        throw std::runtime_error("Unable to format the model prompt.");
    }
    return std::string(formatted.data(), size);
}

template <typename Report>
std::string generate(Engine &engine, const std::string &prompt, Report report) {
    auto *ctx = engine.context.get();
    const auto *vocab = llama_model_get_vocab(engine.model.get());
    const std::string formatted = format_prompt(engine.model.get(), prompt);
    const int required = llama_tokenize(vocab, formatted.data(), formatted.size(), nullptr, 0, true, true);
    if (required >= 0 || -required > context_size - output_limit) {
        throw std::runtime_error("The paragraph and its context exceed the local model window.");
    }
    std::vector<llama_token> tokens(-required);
    if (llama_tokenize(vocab, formatted.data(), formatted.size(), tokens.data(), tokens.size(), true, true) != -required) {
        throw std::runtime_error("Unable to tokenize the paragraph.");
    }

    auto *memory = llama_get_memory(ctx);
    const auto same = std::mismatch(tokens.begin(), tokens.end(), engine.last_prompt.begin(), engine.last_prompt.end());
    int start = std::min(static_cast<int>(std::distance(tokens.begin(), same.first)), -required - 1);
    // Keep the matching prompt prefix and remove earlier generated tokens.
    if (start == 0 || !llama_memory_seq_rm(memory, 0, start, -1)) {
        llama_memory_clear(memory, false);
        start = 0;
    }
    engine.last_prompt.clear();
    for (int i = start; i < -required; i += batch_size) {
        if (engine.cancelled.load()) throw std::runtime_error("Translation cancelled.");
        if (llama_decode(ctx, llama_batch_get_one(tokens.data() + i, std::min(batch_size, -required - i))) != 0) {
            throw std::runtime_error("Local model could not process the paragraph.");
        }
    }
    engine.last_prompt = std::move(tokens);

    std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)> sampler(llama_sampler_init_greedy(), llama_sampler_free);
    std::string output;
    std::vector<char> piece(128);
    report(0);
    for (int i = 0; i < output_limit; i++) {
        if (engine.cancelled.load()) throw std::runtime_error("Translation cancelled.");
        llama_token token = llama_sampler_sample(sampler.get(), ctx, -1);
        if (llama_vocab_is_eog(vocab, token)) return output;
        int length = llama_token_to_piece(vocab, token, piece.data(), piece.size(), 0, false);
        if (length < 0) {
            piece.resize(-length);
            length = llama_token_to_piece(vocab, token, piece.data(), piece.size(), 0, false);
        }
        if (length > 0) output.append(piece.data(), length);
        if (llama_decode(ctx, llama_batch_get_one(&token, 1)) != 0) {
            throw std::runtime_error("Local model generation was interrupted.");
        }
        if (i == 0 || (i + 1) % 8 == 0) report(i + 1);
    }
    throw std::runtime_error("The local model reached its output limit. Try a shorter passage.");
}

template <typename LoadModel>
jlong open_engine(int threads, LoadModel load_model, LoadProgress *progress) {
    std::call_once(backend, [] { llama_backend_init(); });
    auto engine = std::make_unique<Engine>();
    llama_model_params model_params = llama_model_default_params();
    model_params.n_gpu_layers = 0;
    if (progress && progress->test) {
        model_params.progress_callback = LoadProgress::report;
        model_params.progress_callback_user_data = progress;
    }
    engine->model.reset(load_model(model_params));
    if (!engine->model) throw std::runtime_error("Unable to load the verified Hy-MT2 model.");

    llama_context_params params = llama_context_default_params();
    params.n_ctx = context_size;
    params.n_batch = batch_size;
    params.n_ubatch = batch_size;
    params.n_threads = threads;
    params.n_threads_batch = threads;
    engine->context.reset(llama_init_from_model(engine->model.get(), params));
    if (!engine->context) throw std::runtime_error("Unable to allocate the local translation context.");
    llama_set_abort_callback(engine->context.get(), [](void *data) {
        return static_cast<Engine *>(data)->cancelled.load();
    }, engine.get());
    return reinterpret_cast<jlong>(engine.release());
}

jlong open_embedded_engine(std::FILE *archive, jlong offset, int threads, LoadProgress *progress) {
    // GGUF tensor offsets are relative to the complete, aligned APK file.
#ifdef _WIN32
    const int seek = _fseeki64(archive, offset, SEEK_SET);
#else
    const int seek = fseeko(archive, offset, SEEK_SET);
#endif
    if (offset < 0 || seek != 0) throw std::runtime_error("Unable to locate the embedded Hy-MT2 model.");
    return open_engine(threads, [archive](llama_model_params params) {
        params.load_mode = LLAMA_LOAD_MODE_MMAP;
        return llama_model_load_from_file_ptr(archive, params);
    }, progress);
}
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_paperstudio_translator_PrecisionModel_openEngine(JNIEnv *env, jclass, jbyteArray path, jint threads, jobject callback) {
    try {
        const std::string filename = from_bytes(env, path);
        LoadProgress progress{env, callback, callback_method(env, callback, "test", "(I)Z")};
        return open_engine(threads, [&filename](llama_model_params params) {
            return llama_model_load_from_file(filename.c_str(), params);
        }, &progress);
    } catch (const std::exception &error) {
        fail(env, error.what());
        return 0;
    }
}

#ifdef __ANDROID__
extern "C" JNIEXPORT jlong JNICALL
Java_com_paperstudio_translator_PrecisionModel_openBundledEngine(JNIEnv *env, jclass, jint descriptor, jlong offset, jint threads, jobject callback) {
    try {
        const int fd = dup(descriptor);
        if (fd == -1) throw std::runtime_error("Unable to open the APK model descriptor.");
        std::unique_ptr<std::FILE, decltype(&std::fclose)> archive(fdopen(fd, "rb"), std::fclose);
        if (!archive) {
            close(fd);
            throw std::runtime_error("Unable to read the APK model descriptor.");
        }
        LoadProgress progress{env, callback, callback_method(env, callback, "test", "(I)Z")};
        return open_embedded_engine(archive.get(), offset, threads, &progress);
    } catch (const std::exception &error) {
        fail(env, error.what());
        return 0;
    }
}
#endif

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_paperstudio_translator_PrecisionModel_generateText(JNIEnv *env, jclass, jlong handle, jbyteArray prompt, jobject callback) {
    try {
        auto *engine = reinterpret_cast<Engine *>(handle);
        if (!engine) throw std::runtime_error("The local model is not loaded.");
        const jmethodID accept = callback_method(env, callback, "accept", "(I)V");
        std::string output = generate(*engine, from_bytes(env, prompt), [&](int count) {
            if (!accept) return;
            env->CallVoidMethod(callback, accept, count);
            if (env->ExceptionCheck()) throw std::runtime_error("Unable to report translation progress.");
        });
        jbyteArray result = env->NewByteArray(output.size());
        if (result) env->SetByteArrayRegion(result, 0, output.size(), reinterpret_cast<const jbyte *>(output.data()));
        return result;
    } catch (const std::exception &error) {
        fail(env, error.what());
        return nullptr;
    }
}

extern "C" JNIEXPORT void JNICALL
Java_com_paperstudio_translator_PrecisionModel_setCancelled(JNIEnv *, jclass, jlong handle, jboolean value) {
    if (handle) reinterpret_cast<Engine *>(handle)->cancelled.store(value);
}

extern "C" JNIEXPORT void JNICALL
Java_com_paperstudio_translator_PrecisionModel_closeEngine(JNIEnv *, jclass, jlong handle) {
    delete reinterpret_cast<Engine *>(handle);
}
