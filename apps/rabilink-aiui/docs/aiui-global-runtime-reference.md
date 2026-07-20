<!-- docs-language-switch -->
<div align="center">
<a href="./aiui-global-runtime-reference_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# AIUI 全局运行时 API 与 RabiLink 使用边界

本文记录 AIUI QuickJS 运行环境公开的全局作用域、窗口尺寸、定时器、Base64、Fetch 和其他全局挂载能力，并说明它们在 RabiLink 中的正确用法。

## 1. 全局对象

AIUI 遵循 Web 风格的全局作用域约定：

```javascript
window === self;
self === global;
global === globalThis;
```

四个名称指向同一个全局对象。新代码优先使用 `globalThis` 表达“当前运行环境的全局对象”，使用 `window` 读取窗口尺寸。不得把业务运行状态随意挂到全局对象；跨页面的少量非敏感状态使用 `App.globalData`，页面状态保留在页面实例中。

## 2. 窗口尺寸

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `window.innerWidth` | Number | 当前窗口内部宽度，单位为像素 |
| `window.innerHeight` | Number | 当前窗口内部高度，单位为像素 |

RabiLink 可能先以 `448 x 150` 卡片承载，再由宿主把同一个 InkView 扩展为 `480 x 352` modal。尺寸值应在真正需要布局判断时读取，不能只在模块加载阶段缓存一次，也不能把尺寸变化误判为 Page 被重新创建。

页面布局仍应优先使用 WXML/WXSS 的稳定约束。`innerWidth` 和 `innerHeight` 适合诊断、选择少量布局状态或验证宿主 resize，不适合在高频计时器中轮询并反复整帧 `setData()`。

## 3. Navigator 设备信息

AIUI 通过 `navigator` 提供运行环境版本和设备序列号：

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `navigator.userAgent` | String | 当前设备和运行时版本信息 |
| `navigator.getDeviceSerialNumber()` | Function | 返回当前设备唯一 SN |

```javascript
const serialNumber = navigator.getDeviceSerialNumber();
const userAgent = navigator.userAgent;

console.log("SN:", serialNumber);
console.log("UA:", userAgent);
```

适用场景：

- 给设备管理、运行证明和脱敏云日志关联稳定设备身份。
- 识别真机与没有设备 SN 的 Craft 浏览器调试环境。
- 记录运行时版本，帮助判断宿主兼容性。

安全边界：

1. SN 是稳定设备标识和隐私数据，不是密码、token 或可信身份凭证。
2. 不能仅凭客户端提交的 SN 完成账号登录、应用授权或外部写操作；服务器必须通过 token、一次性配对或其他受信任流程建立绑定。
3. 普通 HUD 和日志不展示完整 SN；只有无凭证的本机首次设置页可显示完整 SN，供设备持有者在已登录的管理后台完成绑定。服务端列表和普通排障记录仍使用脱敏预览。
4. `userAgent` 适合诊断和宽松能力判断，不应通过脆弱的完整字符串匹配锁死业务逻辑。
5. 调用 `getDeviceSerialNumber()` 时要检查函数是否存在并捕获异常；Craft 或其他宿主可能不提供真实 SN。

RabiLink 当前已经把安全调用结果保存在页面宿主策略中：真机 SN 用于首次设置页、绑定匹配和眼镜云日志的 `deviceId`，缺失时使用 `unidentified-glasses`；是否启动原生 ASR 仍需结合页面环境和宿主能力判断。SN 只匹配管理后台预先授权的短时领取窗口，后续 Relay 请求仍由服务器签发的设备 token 鉴权。

## 4. 定时器

| API | 返回值 | 说明 |
| --- | --- | --- |
| `setTimeout(callback, delay?, ...args)` | Number | 延迟执行一次，`delay` 默认 `0` 毫秒 |
| `clearTimeout(timerId)` | - | 取消一次性定时器 |
| `setInterval(callback, delay, ...args)` | Number | 按指定间隔重复执行 |
| `clearInterval(intervalId)` | - | 取消重复定时器 |

```javascript
const timerId = setTimeout(() => {
  console.log("2 秒后执行");
}, 2000);

// clearTimeout(timerId);
```

RabiLink 规则：

1. timer ID、回调和宿主对象保存在页面实例上，不能放进需要 JSON 序列化的 `data`。
2. `onHide()` 暂停不应在后台继续的定时器，`onUnload()` 清理全部定时器。
3. 页面重新显示后通过幂等入口恢复轮询，不能叠加多个 interval。
4. 不使用高频 interval 驱动整棵 HUD；只有数据实际变化时才调用最小 `setData()`。
5. 延迟回调执行前重新检查页面 generation、可见性和当前模式，避免旧任务更新新页面状态。

## 5. Base64 编解码

| API | 说明 |
| --- | --- |
| `atob(encodedData)` | 把 Base64 字符串解码为字符串 |
| `btoa(stringToEncode)` | 把 Latin1 范围字符串编码为 Base64 |

```javascript
const encoded = btoa("Hello AIUI");
console.log(encoded); // SGVsbG8gQUlVSQ==

const decoded = atob(encoded);
console.log(decoded); // Hello AIUI
```

注意：官方页面给出的 `SGVsbG8gSlNVST==` 与 `Hello AIUI` 不对应；`btoa("Hello AIUI")` 的正确结果是 `SGVsbG8gQUlVSQ==`。

`btoa()` 只接受 Latin1 范围。中文和完整 Unicode 数据应先通过 `TextEncoder` 转为字节，再采用经过运行时验证的字节到 Base64 方案。Base64 只是编码，不是加密；不得用它保护 token、Cookie 或用户隐私。

## 6. Fetch 网络请求

```javascript
async function getData() {
  try {
    const response = await fetch("https://api.example.com/info");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log("数据:", data);
  } catch (error) {
    console.error("请求失败:", error);
  }
}
```

`fetch(url, options?)` 返回 `Promise<Response>`。常用 `options` 包括 `method`、`headers` 和 `body`。

### Response

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | Boolean | HTTP 状态码是否位于 200 到 299 |
| `status` | Number | HTTP 状态码 |
| `statusText` | String | 状态描述 |
| `url` | String | 最终响应 URL |
| `text()` | Promise<String> | 读取响应文本 |
| `json()` | Promise<Any> | 读取并反序列化 JSON |
| `arrayBuffer()` | Promise<ArrayBuffer> | 读取二进制响应体 |

网络规则：

1. `fetch()` 收到 HTTP 4xx/5xx 时不一定抛异常，必须检查 `response.ok` 或 `status`。
2. `json()` 可能因空响应或无效 JSON 失败；Relay 适配器应把 HTTP 失败、解析失败和网络失败区分记录。
3. 文档没有承诺完整浏览器网络 API。不能因为存在 `fetch()` 就默认 `AbortController`、Cookie jar、Service Worker 或浏览器缓存策略全部可用。
4. 页面不得记录 token、Authorization header、ASR 原文或完整 Agent 私密回复。
5. PC 离线或网络失败时先保留本地持久队列，再做有界重试；不能让转写因为一次 Fetch 失败而丢失。
6. 外部写操作仍经过 RabiRoute 白名单和动作安全门，不能由页面直接绕过。

## 7. 其他全局挂载

以下对象同时挂载到全局作用域和 `window`：

| 对象 | 用途 | RabiLink 边界 |
| --- | --- | --- |
| `console` | 调试日志 | 只写脱敏事件和状态，不写凭证与对话原文 |
| `localStorage` | 本地持久存储 | 保存隔离后的队列和非敏感状态；敏感值最小化 |
| `speechSynthesis` | 原生语音合成 | 按持久待播队列顺序播报，并与 ASR 所有权互斥 |
| `performance` | 性能监控 | 诊断长任务、耗时和渲染问题，不用于业务时钟 |
| `TextEncoder` | 字符串编码为字节 | 处理 UTF-8 请求、签名输入或二进制协议 |
| `TextDecoder` | 字节解码为字符串 | 解码 `ArrayBuffer` 等二进制响应 |

这些名称存在于全局作用域，不等于它们具备浏览器中的全部扩展接口。实际使用的方法必须以 AIUI 官方文档和真机探针结果为准。

## 8. localStorage 本地存储

AIUI 提供按智能体隔离的 Web Storage API。`localStorage` 中的键和值都是字符串，默认没有过期时间。

| 方法 | 返回值 | 说明 |
| --- | --- | --- |
| `getItem(key)` | String 或 `null` | 读取指定键 |
| `setItem(key, value)` | - | 写入字符串；其他类型会被自动转成字符串 |
| `removeItem(key)` | - | 删除指定键 |
| `clear()` | - | 清空当前智能体的全部本地存储 |

```javascript
localStorage.setItem("username", "Rokid Agent");
const name = localStorage.getItem("username");

const user = { id: 1, name: "Admin" };
localStorage.setItem("userInfo", JSON.stringify(user));
const saved = JSON.parse(localStorage.getItem("userInfo") || "null");
console.log(saved?.name || "未保存");
```

隔离性表示不同 Agent 不能直接读取彼此的存储，不表示数据已经加密。敏感数据仍要最小化、可撤销，并避免出现在日志、UI、异常信息和普通设置对象中。

### 眼镜设备凭证

RabiLink 使用 `localStorage` 保存服务器签发的 `rbd_` 设备凭证：

```text
页面没有可用 token
  -> navigator.getDeviceSerialNumber()
  -> 进入 RabiLink Setup，显示完整 SN 和 Relay /manage 地址
  -> 用户登录服务器后台，把 SN 绑定到目标应用
  -> 眼镜轮询 POST /api/rabilink/devices/token
  -> 服务器首次返回一次 rbd_ 设备凭证
  -> 眼镜按 Relay + SN 隔离写入 localStorage
  -> 后续启动直接读取设备凭证并连接 Relay
```

服务器只保存 SN 哈希、脱敏预览和设备凭证哈希，不保存完整 SN 或可直接使用的设备 token。同一绑定只能首次领取一次；本地凭证丢失或被撤销后，用户必须在后台对同一 SN 执行“绑定 / 重置”。

RabiLink 存储规则：

1. 禁止调用 `localStorage.clear()`；它会同时清除其他属于本 Agent 的状态。
2. 删除凭证时只调用 `removeItem()` 删除项目自己的设备凭证键。
3. 键使用 Relay 与 SN 的不可逆本地指纹隔离，不把完整 SN 写进键名。
4. 设备凭证与应用主 token 分离；真眼镜忽略外层注入的应用主 token，只有无设备 SN 的 Craft 调试环境保留兼容。
5. 服务器返回 `401` 时移除失效设备凭证，并重新进入 Setup 显示 SN、后台网址和“绑定 / 重置”步骤。
6. 队列、cursor、云日志与待播消息继续按实际凭证指纹隔离，换绑不会串到其他账号。

## 9. RabiLink 结论

- `window.innerWidth/innerHeight` 用于观察当前 surface，不作为页面生命周期替代品。
- `navigator` 用于设备识别和兼容性诊断；SN 不能替代 token，也不能跳过首次受信任绑定。
- timer 只负责调度，所有重复任务都必须可停止、可恢复且不会叠加。
- Base64 不承担任何安全职责。
- Fetch 是 Relay 通讯基础，但 record-first、本地持久队列和脱敏日志仍不可省略。
- `localStorage`、`speechSynthesis`、`performance` 和编码 API 都应通过项目适配器使用，避免业务代码散落宿主差异。
- `localStorage` 只保存服务器签发、可撤销的设备凭证和项目状态；不持久化外层智能体临时注入的应用主 token。
