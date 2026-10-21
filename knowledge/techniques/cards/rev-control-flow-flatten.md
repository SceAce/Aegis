# 控制流平坦化还原

- id: rev-control-flow-flatten
- category: reverse
- status: verified
- environment: macos
- when: binary, control_flow_flatten
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/reverse/obfuscate/control-flow-flatten.md

## When
函数体是一个 dispatcher + 状态变量 + switch/if 链；基本块被重排。

## Do
1. 找 dispatcher（大 switch/间接跳转）和状态变量赋值。
2. 按状态值抽取基本块，恢复块间转移关系。
3. 用符号执行/动态 trace（angr、Triton、Frida Stalker）辅助恢复。
4. 恢复后用输入验证路径与原程序一致。

## Expect
还原后的控制流能解释输入检查，且与原二进制行为一致。

## Pitfalls
状态变量可能被编码；不要手工重写全部逻辑，先恢复关键比较段。
