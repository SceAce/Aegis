# 流量分析：协议、流与 USB

- id: misc-traffic-pcap
- category: misc
- status: verified
- environment: macos
- when: pcap
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/misc/traffic/introduction.md
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/misc/traffic/protocols/usb.md

## When
pcap/pcapng 里有 HTTP/DNS/USB/自定义协议流量。

## Do
1. 先看协议分层与统计；follow stream 提取明文/文件。
2. HTTP 导出对象；DNS 看异常长域名/编码；USB HID 按描述符解按键。
3. 自定义协议先对齐字段（长度/类型/payload），再重组。
4. 提取结果检查文件头/flag 格式。

## Expect
重组出可读内容或合法文件，且与流量时间线一致。

## Pitfalls
分片/重传要按流重组；USB 键盘要确认 HID 报告格式。
