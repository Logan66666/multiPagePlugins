# Infinitoai

一个基于 Chrome Side Panel 的自动化扩展，用来批量跑通 ChatGPT OAuth 注册 / 登录流程，并把邮箱获取、验证码轮询、OAuth 确认、VPS 回调验证串成一条可连续执行的工作流。

当前版本已经不再只是“点 9 个步骤”的早期脚本，而是演进成了一个带有多邮箱源、多收件通道、自动重试、失败统计、人工接管和域名策略的流程编排器。

## 致谢 Linux.do

感谢 `Linux.do` 佬友们的一切分享。  
[LinuxDo地址：https://linux.do/](https://linux.do/) 

## 项目定位

适合以下场景：

- 批量验证某套 OpenAI OAuth 注册 / 登录链路是否还能跑通
- 在 Duck / 33mail / TMailor 之间切换不同的发信地址来源
- 在 QQ / 163 / Inbucket / TMailor 之间切换不同的验证码收件方式
- 多轮自动运行，观察失败类型、被拦截节点、邮箱域名表现
- 在页面异常、Cloudflare、广告遮挡、验证码错误时尽量自动恢复，必要时再人工接管

## 当前版本重点能力

### 通用工作流能力

- Side Panel 统一控制 9 个步骤，支持单步执行、断点续跑、整套 `Auto`
- 手动点击某一步后，当前步成功会自动续跑后续步骤
- 支持 `Stop` 中断等待、轮询和页面自动化
- 支持有限轮次与无限轮次 `∞` 自动运行
- 无限模式下，即使 run 进入 `PAUSED` 等待人工补充，也仍然受 watchdog 约束，超时后会自动判失败并进入下一轮
- 自动记录成功 / 失败次数，并汇总失败原因
- Console 日志、Toast 提示、状态条、步骤进度全部同步更新
- Console 会保留最近 3 轮日志历史，可在面板中左右切换查看
- Step 8 已是 `OAuth Auto Confirm`，会自动找“继续”按钮并通过 Chrome debugger 点击
- Step 8 会监听 localhost 回调地址并自动写回 Side Panel
- Step 5 同时兼容 `birthday` 页面和 `age` 页面
- Step 6 如果发现当前页面上的 OAuth 链接比面板里保存的更新，会优先使用页面上的最新链接
- Step 7 如果验证码提交后页面明确提示验证码错误，会回邮箱重取，并跳过刚失败的验证码
- 检测 OpenAI 页面里的手机号验证拦截、致命错误页、Unsupported Email 等阻断状态
- VPS 页面支持 502 恢复：
  - Step 1 遇到 502 会重新打开配置里的 OAuth 页面
  - Step 9 提交回调时遇到瞬时 502 会自动重试

### 邮箱源能力

支持三种“注册邮箱来源”：

- `Duck Address`
- `33mail`
- `TMailor`

注意：`Source` 决定 Step 3 使用哪个注册邮箱；`Mail` 决定 Step 4 / Step 7 去哪里收验证码。  
其中 `TMailor` 是一体化方案，既能生成邮箱，也能轮询验证码，因此选中后会隐藏普通 `Mail` 选择器。

### 收件通道能力

支持以下验证码轮询通道：

- `QQ Mail`
- `163 Mail`
- `Inbucket`
- `TMailor 页面 DOM`
- `TMailor API`

## 环境要求

- Chrome 浏览器
- 已开启扩展开发者模式
- 一个可打开并已登录的 VPS 管理面板
- 至少准备一种可用的验证码收件链路：
  - Duck + QQ / 163 / Inbucket
  - 33mail + QQ / 163
  - TMailor
- 如果使用 `QQ / 163 / Inbucket / Duck`，对应页面需要能正常打开并保持可操作状态

## 安装

1. 打开 `chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本项目目录
5. 打开扩展 Side Panel

## 快速上手

推荐第一次先这样跑：

1. 在 `VPS` 中填好 OAuth 面板地址
2. 选择 `Source`
3. 如果 `Source = 33mail`，先配置对应组的 33mail 域名
4. 如果 `Source = Duck`，再选择一个 `Mail` 通道用于收验证码
5. 首次访问 VPS 面板时，如果浏览器弹出站点权限确认，允许当前 VPS 域名
6. 先手动跑 Step 1 -> Step 4，确认邮箱和验证码链路没问题
7. 再跑完整 1 -> 9，确认 OAuth 回调能回写
8. 最后再开启 `Auto`

## Side Panel 配置说明

### `VPS`

你的 OAuth 管理面板地址，例如：

```txt
https://your-panel.example.com/management.html#/oauth
```

Step 1 和 Step 9 都依赖这个地址。

### `Mail`

只在 `Source != TMailor` 时可见。

可选：

- `163 Mail`
- `QQ Mail`
- `Inbucket`

含义：

- `Duck Address` 只负责生成注册邮箱，验证码仍从这里配置的收件通道获取
- `33mail` 只负责生成注册邮箱，验证码仍从对应收件通道获取
- `TMailor` 不使用这里的收件通道，因为它自己完成邮箱生成和轮询

### `Source`

决定 Step 3 用什么邮箱注册：

- `Duck Address`
- `33mail`
- `TMailor`

当前默认源是 `TMailor`。

选择建议：

- `Duck Address`
  - 相对最通用，适合作为默认起手方案
  - 缺点是验证码邮件有时发送较慢，Step 4 / Step 7 可能需要多等几轮
- `33mail`
  - 适合你已经维护好多组域名、并且想配合 `163 / QQ` 转发链路批量跑
  - 但对“不干净”的 IP 仍然比较敏感，注册后仍可能触发 `Add phone`
- `TMailor`
  - 对 IP 的要求相对没那么严格，整体更适合自动跑批
  - 但页面端会不定时遇到 captcha / Cloudflare 风控，必要时可能需要手动接入处理

### `33mail`

只在 `Source = 33mail` 时显示。

需要分别配置：

- `163` 组对应的 33mail 域名
- `QQ` 组对应的 33mail 域名

脚本会根据当前选中的 `Mail` 分组，从对应域名生成邮箱。

### `Rotate`

只在 `Source = 33mail` 时显示。

开启后，`Auto` 模式会在 `163 / QQ` 两组之间自动轮换。  
当前实现带有简单限流窗口：

- 单组 30 分钟窗口
- 最多 6 次使用

当两组都达到窗口上限时，Auto 会等待下一个可用时间点再继续。

### `Inbucket`

只在 `Mail = Inbucket` 时显示。

需要填写：

- `Inbucket host`
- `Mailbox`

脚本会自动访问：

```txt
https://<your-inbucket-host>/m/<mailbox>/
```

### `Email`

当前邮箱输入框有三种行为：

- `Duck`：可手填，也可点右侧按钮自动获取新地址
- `33mail`：Step 3 会按配置自动生成，输入框主要用于展示 / 覆盖
- `TMailor`：右侧按钮会执行“粘贴并校验”，优先读取输入框内容，不行时再尝试剪贴板候选

当 `TMailor` 粘贴进来的邮箱域名不符合当前域名规则时：

- 会清空输入框
- 给出提示
- 自动重新请求新的 TMailor 邮箱

### `Password`

- 留空：自动生成强密码
- 手填：使用自定义密码
- 支持复制、显示 / 隐藏

扩展会把本轮实际使用的密码同步回面板。

### `OAuth`

显示当前缓存的 OAuth 链接。

### `Callback`

显示 Step 8 捕获到的 localhost 回调地址。

### `TMailor`

只在 `Source = TMailor` 时显示，包含：

- `API 状态`
- `Fetch current mailbox code via API`
- `域名模式`
- `白名单域名表`
- `黑名单域名表`
- 每个域名的成功 / 失败计数

当前支持两种域名模式：

- `仅 .com / 白名单`
- `仅白名单`

当前默认模式是 `仅白名单`。

### `Auto / Stop / Reset`

- `Auto`：按顺序执行完整流程
- `Stop`：中断当前流程
- `Reset`：重置步骤状态，但保留顶部配置

## 9 步工作流

1. `Get OAuth Link`
2. `Open Signup`
3. `Fill Email / Password`
4. `Get Signup Code`
5. `Fill Name / Birthday`
6. `Login via OAuth`
7. `Get Login Code`
8. `OAuth Auto Confirm`
9. `VPS Verify`

## Platform Signup Entry Flow

这条流负责“从平台注册入口发起注册，并把账号创建到可进入 OAuth 登录前状态”。

- 入口：`Step 2`
- 固定入口页：`https://platform.openai.com/login`
- 负责步骤：`Step 2 -> Step 3 -> Step 4 -> Step 5`
- 成功标志：完成注册邮箱提交、验证码确认、资料页填写
- 常见阻断：平台仍停在已登录会话、注册页超时、Unsupported Email、手机号验证

调试建议：

- 先看是不是还停在 `platform.openai.com/login`
- 再看是否已经前进到 `email-verification` / `about-you`
- 最后区分是 Step 3 凭证提交问题，还是 Step 4 / Step 5 页面推进问题

## OAuth Login Flow

这条流负责“拿着已经注册好的账号，重新进入 OAuth 登录链路并完成授权回调”。

- 入口：`Step 6`
- 固定入口动作：先刷新最新 OAuth 链接，再重开登录链路
- 负责步骤：`Step 6 -> Step 7 -> Step 8 -> Step 9`
- 成功标志：抓到 localhost callback，并在 VPS 面板回填验证
- 常见阻断：密码页不推进、登录验证码错误、OAuth 同意页点击失败、VPS 面板 502

调试建议：

- 先确认 Step 6 是否拿到了最新 OAuth URL
- 再看是卡在登录邮箱页 / 密码页，还是已经进入邮箱验证码页
- 如果 Step 8 已完成，就只需要围绕 localhost callback 和 Step 9 去排查

### Step 1: Get OAuth Link

- 打开 VPS OAuth 面板
- 等待目标卡片出现
- 读取授权链接
- 如果页面是 502，会重新打开配置的 OAuth 页面而不是原地卡死

### Step 2: Open Signup

- 固定从 `https://platform.openai.com/login` 进入，不再依赖 OAuth 链接直达注册页
- 如果被重定向到已登录的 `platform.openai.com/home` / `chat`，会先自动尝试登出再回到登录页
- 如果页面已经直接出现邮箱输入框，会直接进入下一步，不再强依赖 `Sign up / Register / 创建账户` 按钮

### Step 3: Fill Email / Password

- 自动填写邮箱
- 若同页已经直接出现密码框，会先补密码再继续
- 若页面出现“使用一次性验证码登录”，会切到一次性验证码注册流
- 也兼容邮箱页 / 密码页分离的流程
- 会把最终密码同步回面板
- 若 `Source = TMailor`，还会先校验当前邮箱是否符合域名策略

### Step 4: Get Signup Code

- 按注册验证码配置去轮询邮箱
- 会优先匹配注册阶段邮件特征
- 对中文标题 `你的 ChatGPT 代码为 xxxxxx` 这类邮件已做兼容

### Step 5: Fill Name / Birthday

- 自动填写姓名和生日 / 年龄
- 能识别 `birthday` 页面与 `age` 页面
- 也会检测 Unsupported Email / 致命错误页

### Step 6: Login via OAuth

- 先刷新最新 OAuth 链接，再重新打开 OAuth 登录链路
- 登录页实际会落到 `auth.openai.com` 的邮箱页 / 密码页，脚本会分步填写
- 如果页面上的 OAuth 链接比面板里保存的新，会自动改用页面最新链接
- 支持密码流、OTP 流、自动跳转场景

### Step 7: Get Login Code

- 使用登录验证码匹配配置轮询邮箱
- 默认和 Step 4 分离处理，避免把注册验证码当成登录验证码
- 提交错误验证码后会自动跳过该验证码并重查

### Step 8: OAuth Auto Confirm

- 自动寻找同意页“继续”按钮
- 通过 Chrome debugger 输入事件点击
- 监听 `chrome.webNavigation.onBeforeNavigate`
- 抓到 localhost 回调后保存到面板

另外还会：

- 检测手机验证拦截
- 检测 `max_check_attempts` 等致命错误页
- 在无法完成时快速失败，交还控制权

### Step 9: VPS Verify

- 返回 VPS 面板
- 自动填写 localhost 回调地址
- 自动提交
- Step 9 提交后若遇到瞬时 502，会自动重试

## 邮箱源说明

### `Duck Address`

适合：

- 已登录 DuckDuckGo Email Protection
- 想继续用 QQ / 163 / Inbucket 收验证码

当前能力：

- 自动打开 Duck Autofill 设置页
- 读取当前私有地址
- 必要时点击 `Generate Private Duck Address`
- 将生成结果写回 Side Panel

### `33mail`

适合：

- 想用自己维护的 33mail 域名分组跑批
- 希望在 `163 / QQ` 两条转发链路之间切换

当前能力：

- 按当前收件组自动生成新地址
- 163 / QQ 双分组独立配置域名
- Auto 模式下支持 163 / QQ 自动轮换
- 带 30 分钟窗口内单组最多 6 次的简单限流逻辑
- 运行时会记录组使用情况，避免单组被快速打满

说明：

- 33mail 只负责“生成注册邮箱”
- 验证码仍从 `Mail` 里配置的对应收件通道获取

### `TMailor`

适合：

- 希望自动生成临时邮箱
- 希望直接从 TMailor 收取验证码
- 希望把域名质量管理、API 探测、页面回退都集中到一个来源上

当前能力分两层：

### 1. TMailor API 层

- Step 3 优先通过 API 请求新邮箱
- Side Panel 会自动检测 API 状态
- 可以手动用 API 拉取“当前邮箱”的验证码
- API 返回 `errorcaptcha` 等阻断时，面板会显示简短状态：

```txt
TMailor API triggered a Cloudflare captcha.
```

### 2. TMailor 页面层

当 API 失败或被风控时，会打开 `https://tmailor.com/` 进入页面流：

- 自动等待邮箱页面加载完成
- 自动点击 `New Email`
- 自动处理域名选择
- 自动刷新收件箱
- 自动打开匹配邮件
- 从正文读取验证码
- 在 Step 4 / Step 7 中，进入正文取到验证码后会返回首页 / 收件页，减少广告或正文页干扰

### 3. TMailor 风控 / 干扰处理

当前页面流已经内置以下恢复能力：

- 自动尝试处理 Cloudflare / Turnstile
- 点击验证控件时使用 debugger 坐标点击
- 区分全页 Cloudflare 和邮箱页内 Turnstile
- 避免把普通邮箱区块误判成 Cloudflare challenge
- 自动关闭 `ad_position_box` 这类遮挡广告
- 自动播放并关闭 monetization video ad
- 防止 interruption sweep 重入
- Cloudflare 未处理成功时，明确转为人工接管

### 4. TMailor 域名策略

TMailor 不再是“拿到什么域名就用什么域名”，而是带有策略：

- 内置种子白名单 / 黑名单
- 支持 `仅 .com / 白名单`
- 支持 `仅白名单`
- 成功跑通的 `.com` 域名会自动提升到白名单
- 某些失败类型会把域名记为失败，必要时加入黑名单

触发黑名单记录的典型场景：

- Unsupported Email
- 登录后仍要求手机号验证
- 提交资料后进入致命错误页

当前内置黑名单已包含部分已知不稳定域名，例如：

- `hetzez.com`
- `pippoc.com`

### 5. TMailor 邮箱锁定策略

当系统已经拿到一个可用的 `TMailor access token` 后：

- Step 4 / Step 7 会优先走 API 收件
- 如果当前邮箱已经锁定到这个 token，必要时会跳过页面打开和 DOM fallback，避免切到另一个邮箱

## 收件通道说明

### `QQ Mail`

- 网页轮询
- 会做列表刷新
- 针对部分刷新异常，增加了“重要联系人 -> 收件箱”的刷新路径

### `163 Mail`

- 网页轮询
- 用统一的邮件匹配 / 新鲜度策略抽取验证码

### `Inbucket`

- 使用自定义 host + mailbox
- 只检查目标 mailbox 页面
- 支持刷新与未读消息识别

## 自动运行与人工接管

### Auto 模式

Auto 会按顺序执行完整流程，并支持：

- 指定轮次
- 无限轮次
- 多轮失败后继续下一轮
- 失败统计聚合
- 中途等待手动接管后继续

### Auto Continue

当某一步无法自动拿到邮箱或需要你手工补充时，系统会暂停，并显示继续提示。  
你补完必要信息后可以点 `Continue` 恢复当前 run。

### Stop

`Stop` 会向后台和内容脚本广播停止意图，尽量中断：

- sleep
- 轮询
- 页面等待
- 邮件等待
- 自动运行循环

## 日志、状态和可观测性

当前 UI 会提供：

- 运行状态条
- 每步完成 / 失败状态
- Console 实时日志
- 最近 3 轮 Console 日志历史，以及左右切换按钮
- 自动运行成功 / 失败计数
- 失败原因聚合视图
- Toast 提示
- TMailor API 状态提示

## 项目结构

```txt
background.js                    后台主控，编排 1~9 步、Auto、状态管理
manifest.json                    MV3 扩展清单

content/signup-page.js           OpenAI auth shared shell，只保留公共路由与共享 helper
content/openai-auth-step3-flow.js
                                 Platform Signup Entry Flow 的 Step 3 实现
content/openai-auth-step6-flow.js
                                 OAuth Login Flow 的 Step 6 实现
content/openai-auth-step2-handler.js
content/openai-auth-step3-handler.js
content/openai-auth-step5-handler.js
content/openai-auth-step6-handler.js
content/openai-auth-step8-handler.js
content/openai-auth-actions-handler.js
                                 OpenAI auth 各步骤 / 动作的显式注册入口
content/vps-panel.js             VPS 面板 Step 1 / Step 9
content/duck-mail.js             Duck 地址获取
content/qq-mail.js               QQ 邮箱轮询
content/mail-163.js              163 邮箱轮询
content/inbucket-mail.js         Inbucket 轮询
content/tmailor-mail.js          TMailor 页面流、Cloudflare、广告处理、验证码读取
content/turnstile-screenxy-patch.js
                                 TMailor / Turnstile 坐标点击补丁

shared/email-addresses.js        33mail / 邮箱源工具
shared/mail-provider-rotation.js 33mail 分组轮换与窗口限流
shared/tmailor-api.js            TMailor API 请求、收件轮询
shared/tmailor-domains.js        TMailor 白名单 / 黑名单 / 统计 / 模式
shared/tmailor-errors.js         TMailor API 风控错误文案
shared/tmailor-mailbox-strategy.js
                                 TMailor API 邮箱锁定策略
shared/tmailor-verification-profiles.js
                                 TMailor Step 4 / Step 7 验证码配置
shared/sidepanel-settings.js     顶部设置持久化

sidepanel/                       Side Panel UI
tests/                           Node 测试
data/                            姓名、域名等静态数据
```

## 调试建议

遇到问题时建议按这个顺序看：

1. Side Panel Console
2. Service Worker 控制台
3. 目标页面控制台
4. `tests/` 中对应模块的单元测试

尤其建议关注这些信号：

- TMailor API 状态是否异常
- TMailor 是否误判成 Cloudflare
- 当前 run 是否进入 `PAUSED`
- Step 8 是否被手机号验证拦截
- VPS 是否出现 502

## 已知限制

- Step 8 仍然最依赖页面 DOM 结构
- VPS 面板选择器需要与你的页面实际结构一致
- Duck 自动获取依赖 Duck 页面真实 DOM
- 各邮箱页面一旦大改版，轮询脚本可能需要跟着调整
- TMailor 的 Cloudflare / 广告逻辑已经做了大量兜底，但仍可能遇到必须人工接管的节点

## 安全与数据说明

- 运行态主要保存在 `chrome.storage.session`，只有 Side Panel 会读取完整状态
- 顶部配置会做持久化保存
- 不会硬编码你的 VPS、邮箱或密码
- 内容脚本只能读取净化后的运行状态，不会拿到密码、OAuth URL、localhost callback、TMailor token 或账号历史
- Console 日志、Toast、复制出来的日志历史都会先做脱敏处理
- 普通状态广播不会再携带密码、OAuth URL、localhost callback 或 TMailor token
- 扩展不再请求 `<all_urls>`；固定权限只覆盖 OpenAI、邮箱和 TMailor 等已知站点，VPS 面板域名会在使用时按需授权
- 当前 run 的敏感值仍会保存在可信会话态里，便于 Side Panel 展示、复制和流程恢复

## 测试

完整测试命令：

```powershell
node --test .\tests\*.test.js
```

常见定向测试：

```powershell
node .\tests\tmailor-mail.test.js
node .\tests\tmailor-api.test.js
node .\tests\tmailor-domains.test.js
node .\tests\signup-page-verification.test.js
node .\tests\vps-panel.test.js
node .\tests\runtime-state-security.test.js
node .\tests\log-redaction.test.js
node .\tests\data-update-redaction.test.js
```
