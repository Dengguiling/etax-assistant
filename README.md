# 电子税局助手（Chrome 扩展）

管理多家公司的电子税局账号，在侧边栏搜索公司名 → 回车一键自动填充「统一社会信用代码 / 用户名 / 密码」到广东电子税局登录页，免去在 Excel 与网页间复制粘贴。

> 由原 [gd-tax-plugin](https://github.com/Dengguiling/gd-tax-plugin)（Tampermonkey 脚本）重写为 Chrome 原生扩展（Manifest V3）。沿用其已验证有效的登录页 DOM 路径，并升级为 Side Panel 侧边栏 + 加密存储。

## 功能

- 📄 **导入 Excel 账号表**：支持 `.xlsx / .xls / .csv`，自动识别列头（公司名称、信用代码、用户名、密码），识别不准可在导入前手动调整列对应关系。
- 🔍 **快速搜索**：按公司名 / 信用代码 / 用户名模糊搜索，支持上下键选择、回车填充。
- ⚡ **自动填充**：点击或回车后，自动把三个字段填入税局登录页的对应输入框（兼容 Vue + ElementUI 的响应式表单）。
- 🔒 **密码加密存储**：使用 AES-GCM（Web Crypto API）加密后存入 `chrome.storage.local`，密钥随机生成保存在本地，不上云。
- ⚙ **字段可配置**：税局页面改版导致自动匹配失败时，可在设置里手动填写 CSS selector 兜底，并提供诊断信息辅助定位。

## 安装（开发者模式加载）

1. 打开 Chrome，地址栏输入 `chrome://extensions`。
2. 右上角打开「开发者模式」开关。
3. 点击「加载已解压的扩展程序」，选择本目录 `etax-assistant/`。
4. 安装后，点击工具栏的「电子税局助手」图标 → 浏览器右侧打开侧边栏。

> 需 Chrome 114+（Side Panel API 要求）。

## 使用

1. **导入账号**：点「导入 Excel 账号表」，选择你的账号 Excel。确认列对应关系后点「确认导入」。
   - 推荐 Excel 四列：`公司名称 | 统一信用代码 | 实名账号 | 密码`（工作表名建议 `客户信息表`）。
   - 仓库自带测试文件 [`sample/账号示例.xlsx`](./sample/账号示例.xlsx)，含 3 条虚构数据，可直接拿它试导入和填充流程。
2. **打开税局登录页**：访问 `https://tpass.guangdong.chinatax.gov.cn:8443/#/login`。
3. **搜索填充**：在侧边栏搜索框输入公司名 → 上下键选中 → **回车**（或点击列表项）→ 三个输入框自动填好 → 直接点页面上的「登录」。

## Excel 列头识别规则

导入时会按以下关键词自动匹配列（中英文、大小写不敏感；长关键词优先）。与原 tampermonkey 脚本（`gd-tax-plugin`）的固定格式完全兼容。

| 字段 | 识别关键词 |
|------|-----------|
| 公司名称 | 公司名称、公司、企业、单位、名称、客户、主体、company、name |
| 信用代码 | 统一信用代码、统一社会信用、信用代码、社会信用、税号、纳税人识别、credit、uscc、taxno |
| 用户名 | 实名账号、登录账号、用户名、登录名、账号、实名、用户、手机、身份证、username、account |
| 密码 | 密码、口令、password、pwd |

匹配不到时按前 4 列顺序兜底，并可在导入确认界面手动调整下拉框。

> 📌 **信用代码格式校验**：导入时按 `^[A-Za-z0-9]{18}$`（18 位字母数字）校验。不规范的行会提示但仍允许导入，方便个别特殊主体。

## 自动填充的字段定位（三层兜底）

税局新版登录页（`tpass.guangdong.chinatax.gov.cn`）基于 Vue + ElementUI。字段定位按**优先级从高到低**：

1. **用户自定义 CSS selector（最高）**：点侧边栏右上角 ⚙ → 为某字段填入 selector（如 `input[name='loginname']`），留空则跳过。页面改版导致其它方式失效时的终极兜底。
2. **精确选择器（已验证有效）**：来自旧版 tampermonkey 脚本实际跑通的路径，直接命中 `.loginCls .login_box .formContentE form` 下第 1/2/3 个 `.el-form-item` 的 input。绝大多数情况下这一层就能成功。
3. **智能关键词匹配**：扫描页面所有可见 `input`，综合 `placeholder / aria-label / id / name / type / 邻近 label 文本` 打分。`type=password` 给密码字段额外加权；验证码等字段排除。
4. **诊断信息**：填充失败时，侧边栏下方列出页面上候选 `input` 的 `placeholder / id / name / aria-label / label`，据此快速确定要填写的 selector。

### 填充原理（为什么能填进 Vue 表单）

直接 `el.value = x` 不会触发 Vue 的响应式更新。插件使用原生 setter 并派发事件：

```js
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
setter.call(el, value);
el.dispatchEvent(new Event('input',  { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
el.dispatchEvent(new Event('blur',   { bubbles: true }));
```

## 首次使用排查清单

如果回车后提示「部分字段未填充」：

1. 查看侧边栏下方「诊断信息」，找到目标字段对应的 `input`。
2. 记下它的 `id` 或 `name`，拼成 selector，例如 `id="creditCode"` → `#creditCode`；`name="pwd"` → `input[name='pwd']`。
3. 点 ⚙ 设置 → 填入对应字段 → 保存 → 重新搜索回车。

如果「无法填充 / 无响应」：

- 确认当前 tab 是广东电子税局域名（`*.guangdong.chinatax.gov.cn`）。
- 刷新一次登录页（确保 content script 已注入）再试。
- 登录页若在弹窗/新打开的小窗口里，把那个窗口作为当前激活 tab 操作。

## 目录结构

```
etax-assistant/
├── manifest.json          MV3 配置
├── background.js          service worker：加解密、storage、消息路由
├── sidepanel/
│   ├── sidepanel.html     侧边栏 UI
│   ├── sidepanel.css
│   ├── sidepanel.js       导入/搜索/回车填充
│   └── crypto.js          AES-GCM 加解密
├── content/
│   ├── matcher.js         智能字段匹配（评分）
│   └── content.js         接收 FILL 消息并执行填充
├── lib/xlsx.full.min.js   SheetJS（Excel 解析）
├── icons/                 16/48/128 图标
├── sample/账号示例.xlsx   测试数据（3 条虚构账号）
└── README.md
```

## 数据与隐私

- 所有账号数据仅保存在本机 `chrome.storage.local`，不发送到任何服务器。
- 仅密码字段加密；公司名 / 信用代码 / 用户名明文存储以便搜索展示。
- content script 仅注入 `*.guangdong.chinatax.gov.cn` 域名，不干扰其他网站。
- 清空数据：侧边栏「清空全部」按钮；或卸载扩展。

## 已知限制

- 智能匹配基于 ElementUI 通用结构和常见关键词设计；税局页面若使用非常规的自定义控件，可能需要手动配置 selector（见上文排查清单）。
- 某些高安全级别的密码输入框会拦截程序化赋值（如强制要求物理键盘输入）。遇到这种情况插件会提示该字段未填充，可改用侧边栏后续可扩展的「复制密码」功能（当前版本尚未提供，欢迎反馈）。
