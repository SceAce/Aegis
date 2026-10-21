# 图片隐写：元数据、LSB 与附加数据

- id: misc-image-stego
- category: misc
- curation: reviewed
- environment: any
- triggers: image, stego
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/misc/picture/introduction.md
- evidence-ref: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/misc/picture/png.md
- reviewed-by: human

## When
图片文件异常大/有可疑元数据/像素最低位可能藏数据。

## Do
1. 先看 exif/comment/尾部附加数据；binwalk/foremost 拆嵌套文件。
2. PNG 检查 IDAT 块、调色板、CRC 与像素 LSB；用 zsteg/自定义脚本提取。
3. JPG 看 DCT/量化表/尾部；GIF 看帧与调色板。
4. 提取结果检查魔数与文本结构。

## Expect
提取出的数据是合法文件或可读文本，并能解释嵌入方式。

## Limits
LSB 位序/通道顺序会变；先确认 PNG 颜色类型。
