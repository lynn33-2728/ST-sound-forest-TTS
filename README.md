# 声林 TTS · 多引擎语音插件 for SillyTavern

一个用于 SillyTavern（酒馆）的多引擎 TTS 语音扩展：一个插件，四个引擎随便切。

- **硅基流动 SiliconFlow**：CosyVoice2，支持在线克隆音色
- **火山引擎**：大模型语音合成，内置 100+ 音色（通用 / 角色扮演 / 方言 / 多语种），支持 `ICL_` 声音复刻
- **MiniMax**：Speech-02 / 2.6 系列模型，支持声音复刻音色 ID
- **MOSS**：MOSS-TTS，使用 `voice_id` 合成语音，支持在插件内上传参考音频创建音色

本项目基于 [hjl2004-10/extension](https://github.com/hjl2004-10/extension) 修改演进，感谢原作者的项目基础。

## 功能一览

- 侧栏式设置面板：**API / 文本截取 / 缓存 / 日志** 四大块，点哪看哪
- 引擎一键切换，四家配置独立保存，互不影响
- **文本截取设置三引擎共用**：符号提取、标签块规则、全文发送上限，设一次全都生效
- **火山长文本自动拆分**：超过单段安全长度时按句子拆开，依次生成并连续播放
- 自动朗读角色消息（可开关），每条消息旁有手动 ▶ 按钮
- **缓存面板**：四个引擎的语音缓存并列显示，重听不扣费，可下载 mp3、可单删、可清空
- 多人角色音色：群聊按角色名分配音色，四个引擎分开存
- 自绘悬浮进度条：可拖动、可调速、可下载，PC / 平板 / 手机都适配
- 日志面板：每一步合成过程可见，排查问题不求人

## 安装

### 方法一：Gitee 下载（国内免登录，推荐）

下载 zip：

```text
https://gitee.com/lynn/sound-forest-TTS/repository/archive/master.zip
```

解压后把文件夹重命名为 `ST-sound-forest-TTS`，放到：

```text
SillyTavern/data/default-user/extensions/ST-sound-forest-TTS
```

### 方法二：GitHub

```text
https://github.com/lynn33-2728/sound-forest-TTS
```

然后刷新 SillyTavern 页面，打开「扩展 → 声林 · 多引擎语音（TTS）」配置 API。

## 各引擎配置

| 引擎 | 需要填写 | 获取地址 |
|---|---|---|
| 硅基流动 | API 密钥 | [siliconflow.cn](https://siliconflow.cn) |
| 火山引擎 | AppID + Access Key | [火山引擎语音控制台](https://console.volcengine.com/speech/overview)（开通「大模型语音合成」） |
| MiniMax | API Key + GroupID | [MiniMax 开放平台](https://platform.minimaxi.com)（账户管理 → 接口密钥） |
| MOSS | API Key + voice_id | [Moss API 平台](https://platform.mosi.cn/docs/getting-started/auth/) |

说明：

- 火山引擎、MiniMax 和 MOSS 的请求经酒馆服务端 `/proxy` 中转，请使用较新版本 SillyTavern。
- 声音复刻：硅基在插件里直接上传音频克隆；火山 / MiniMax 在各自平台控制台复刻后，把音色 ID 填进「自定义音色ID」即可。
- MOSS 的 TTS 接口只接受 `voice_id`，不接受直接把参考音频塞进朗读请求；插件内克隆会先调用 MOSS 创建音色，拿到 `voice_id` 后自动选中。
- MiniMax 语音按字符计费；若已订阅 Token Plan，请使用「订阅 Key」填入 API Key 栏。

## 出处与许可

本项目是 [hjl2004-10/extension](https://github.com/hjl2004-10/extension) 的修改版。

原项目版权归原作者所有。修改部分由本仓库维护者添加。项目按 MIT License 发布，详见 [LICENSE](LICENSE)。
