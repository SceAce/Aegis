# 音频隐写/编码

- id: misc-audio
- category: misc
- curation: reviewed
- environment: any
- triggers: audio, stego
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/misc/audio/introduction.md
- reviewed-by: human

## When
wav/mp3 等音频文件异常，可能藏摩斯/DTMF/频谱/LSB。

## Do
1. 看头/时长/采样率；用频谱图找图案或文字。
2. 检查 DTMF/摩斯/慢扫描电视；试 LSB/回声隐藏。
3. 提取结果检查可读文本/flag 格式。
4. 必要时按采样点手写解码。

## Expect
得到可读文本/图像，且能解释编码方式。

## Limits
有损压缩会破坏 LSB；先确认容器/编码。
