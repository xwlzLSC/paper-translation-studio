"""An offline bilingual example; the text and figures are illustrative."""
from scan import wrap

NAME = "采样电路 - 双语阅读示例.pdf"
PAGES = [
    [
        ("Reducing noise in a sampled circuit", "降低采样电路中的噪声"),
        ("Abstract. A sampling circuit captures the input voltage during a short observation window. "
         "A larger sampling capacitor reduces thermal noise but increases settling time.",
         "摘要。采样电路在短暂的观测窗口内捕获输入电压。增大采样电容可以降低热噪声，但会延长建立时间。"),
        ("The noise variance scales with the ratio of thermal energy to capacitance. "
         "This trade-off constrains the choice of sampling capacitor.",
         "噪声方差与热能和电容之比成正比。这一权衡限制了采样电容的选择。"),
        ("Figure 1. Illustrative settling response during the sampling interval.",
         "图 1. 采样期间的建立响应示意。"),
    ],
    [
        ("Measuring the settling error", "测量建立误差"),
        ("Measure the output immediately before the sampling switch opens. Repeat the measurement "
         "under the same input conditions to estimate the variability.",
         "在采样开关断开前测量输出。在相同的输入条件下重复测量，以估计测量值的波动。"),
        ("Report the observation window, the sampling capacitance, and the temperature so the "
         "measurements can be compared across designs.",
         "报告观测窗口、采样电容和温度，以便在不同设计之间比较测量结果。"),
    ],
]
SEGMENTS = {str(i): {"mode": "layout", "pairs": pairs} for i, pairs in enumerate(PAGES, 1)}


def write(fitz, path, translated=False, *, replaced_page=None, replacements=()):
    ink = (0.12, 0.20, 0.18)
    accent = (0.07, 0.41, 0.34)
    font = fitz.Font("cjk" if translated else "tiro")
    with fitz.open() as doc:
        for number, pairs in enumerate(PAGES, 1):
            page = doc.new_page(width=540, height=695)
            page.insert_text((48, 47), "PAPER STUDIO   /   READING SAMPLE", fontname="hebo",
                             fontsize=10, color=accent)
            page.draw_line((48, 61), (492, 61), color=accent, width=0.6)
            writer = fitz.TextWriter(page.rect)
            y = 110

            def write_block(text, size, leading):
                nonlocal y
                for line in wrap(text, font, size, 444):
                    writer.append((48, y), line, font=font, fontsize=size)
                    y += leading
                y += 12

            for index, pair in enumerate(pairs):
                if number == 1 and index == 3:
                    y = max(y, 286)
                    page.insert_text((48, y + 4), "noise variance = kT / C", fontname="tiit",
                                     fontsize=14, color=ink)
                    y += 38
                    page.draw_rect((48, y, 492, y + 139), color=(0.75, 0.83, 0.79),
                                   fill=(0.95, 0.97, 0.94), width=0.6)
                    page.draw_polyline([(81, y + 26), (81, y + 111), (462, y + 111)],
                                       color=(0.35, 0.46, 0.40), width=0.9)
                    curve = [(81 + x, y + 103 - 66 * (1 - 0.985 ** x)) for x in range(0, 371, 5)]
                    page.draw_polyline(curve, color=accent, width=1.8)
                    y += 163
                text = replacements[index] if number == replaced_page else pair[int(translated)]
                write_block(text, 25 if index == 0 else 13,
                            32 if index == 0 else 20)
            writer.write_text(page, color=ink)
            page.draw_line((48, 631), (492, 631), color=(0.75, 0.83, 0.79), width=0.6)
            page.insert_text((48, 655), f"ILLUSTRATIVE DOCUMENT   /   {number:02d}", fontname="helv",
                             fontsize=9, color=accent)
        doc.set_toc([
            [1, "降低采样电路中的噪声" if translated else "Reducing noise in a sampled circuit", 1],
            [2, "图 1 · 建立响应示意" if translated else "Figure 1 · Settling response", 1],
            [1, "测量建立误差" if translated else "Measuring the settling error", 2],
        ])
        doc.subset_fonts()
        doc.save(path, garbage=3, deflate=True)
