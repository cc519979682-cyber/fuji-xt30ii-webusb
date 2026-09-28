# 协议参考与出处

此程序的 JavaScript 代码是为本任务独立编写的，没有复制第三方项目的源代码。

- [Fujifilm X-T30 II 官方 USB 说明](https://fujifilm-dsc.com/en-int/manual/x-t30-2/connections/computer/)：USB RAW CONV./BACKUP RESTORE 模式。
- [Fujifilm X-T30 II 官方画质设置说明](https://app.fujifilm-dsc.com/en/manual/x-t30-2/menu_shooting/image_quality_setting/)：胶片模拟和参数范围。
- [FilmKit](https://github.com/eggricesoy/filmkit)（MIT 许可证）：公开记录了 Fuji 自定义档位的 USB PTP 属性编号、数值编码和 WebUSB 方法；本程序仅参考协议事实。
- [Fuji PTP Recipes](https://github.com/ILFforever/fujifilm-ptp-recipes)（文档 CC BY 4.0）：公开记录了 C 档选择器 `0xD18C`、名称 `0xD18D`、属性块以及 `0xD1A5` 属于当前拍摄状态等协议观察。
- [Filmcase PTP 编码说明](https://github.com/gosku/Filmcase/blob/main/docs/ptp_encodings.md)（项目 GPL v3）：X-S10 等机身的属性编码和回读行为参考；没有使用其代码。

开发期间在一台 X-T30 II 固件 2.04 上进行的只读 USB PTP 探测显示：机身型号可读取，`0xD18C` 至 `0xD1A4` 的私有属性可逐项读取，数值属性返回 2 字节；`GetDeviceInfo` 的公开属性列表为空，因此本程序不以该列表作为支持性判断。其他机身和固件未验证。

## 参考图

`reference.jpg` 由内置 imagegen 工具生成的参考图转换而来，用于观察肤色、绿叶、天空、花朵以及明暗变化。它不是相机拍摄的样片。生成提示词：

> Use case: photorealistic-natural. Asset type: neutral reference photograph for a Fujifilm X-T30 II color and tone adjustment preview in a local camera settings app. Create a single realistic 3:2 horizontal photograph on a clear afternoon: one adult East Asian woman in a plain cream shirt standing naturally on a city garden walkway, with green leaves, a muted terracotta wall, patches of blue sky, a white flower and a small red flower, sunlit highlights and deep but detailed shadows. Compose as a candid photograph with the woman slightly left of center and enough varied color and texture across the frame to reveal color saturation, skin tones, white balance, highlight/shadow, grain and sharpness changes. Neutral accurate color, moderate contrast, natural daylight, photographic detail. No camera or brand in view, no text, no watermark, no collage, no filters or dramatic grading.
