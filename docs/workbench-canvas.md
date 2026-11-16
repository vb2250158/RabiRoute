[English](workbench-canvas_en.md) | 简体中文

# 工作台画布

工作台插件 0.2.2 将项目拆成项目元数据和独立画布目录。旧媒体项目仍可打开；点击「迁移为多画布项目」才创建备份并转换，普通读取不迁移。

迁移先保存完整旧存档备份，再封闭旧文件并提交新项目；旧客户端不能继续写入。提交中断时项目列表显示「恢复迁移」，在原电脑点击可继续原事务。若旧文件或备份摘要不一致，保留双方记录并停止迁移。

```text
projects/<projectId>/
  project.json
  canvases/<canvasId>/
    canvas.json
    materials/
  .canvas-index/          # 可重建摘要，不是画布真源
```

每张画布使用自己的 revision 保存；两人分别编辑不同画布不会争用项目 revision。同张画布发生 409 时保留页面编辑，不自动覆盖。列表每页 50 项，服务端支持游标和名称搜索，打开画布后才读取节点正文。

复制整张画布目录可携带定义与专属材料。页面「复制」或「登记副本」会分配新身份并重映射内部节点引用。目录联接、路径越界和坏引用拒绝导入；共享模型、外部资产、电脑绑定和模板仍需在目标环境提供。副本不会沿用原运行的进程或执行权。

## 编辑和运行

画布提供 command、agent、human、generate、asset 节点、控制边、变量及分组合同。原媒体编辑器保留在「媒体编辑」入口；它和图编辑共用画布 revision。媒体草稿作为画布材料保存，画布节点保留其稳定引用。

节点参数、inputs 和 requirements 可在参数面板编辑。连接条件为 success 或 completed，多入边为 AND；必需门禁失败停止后续派发，普通失败仍保留错误汇总。默认串行；统一运行 API 可显式指定并发 1–16，同一 resourceKey 的节点串行执行。

保存、导出及切换节点时会应用当前参数草稿，JSON 错误会显示在页面并保留编辑。运行前保存整张画布。导出包含当前变量及节点位置，保存期间继续输入的内容保留为未保存编辑。

画布与运行历史的下一页会追加到当前列表。运行日志每次读取 100 条，页面保留最近加载的 500 条；使用「继续读取日志」向后读取，或「从头读取日志」回到开头。

执行电脑在视频组件目录的 `workbench-bindings.json` 保存本机工具与路径绑定。图不能指定凭据值或修改这份可信配置。示例中的路径需要替换为实际目录；runtime 必须在本机，项目根可以指向共享存储：

```json
{
  "projectsRoot": "\\\\fileserver\\projects\\workbench",
  "workspaces": {
    "example-workspace": {
      "roots": {
        "runtime": "C:\\RabiRuntime\\example",
        "output": "C:\\RabiRuntime\\example\\output",
        "materials": "C:\\RabiMaterials\\example"
      },
      "tools": {
        "python": {
          "executable": "C:\\RabiTools\\python\\python.exe",
          "argvPrefix": [],
          "envRefs": { "EXAMPLE_API_KEY": "EXAMPLE_API_KEY" }
        }
      }
    }
  }
}
```

未配置 projectsRoot 时沿用原项目根。配置共享根后，旧项目仍从原位置读取；显式迁移才写入共享根。`canvas` 输入根由存储拥有者自动解析为当前画布目录，可用 `{ "root": "canvas", "path": "materials/brief.txt" }` 引用随目录复制的材料。

命令节点配置 `toolKey`、字符串数组 `argv`、可选 timeoutMs 与 validationOnly。执行复用宿主 ProcessLeaseRegistry，关闭 shell、隐藏进程窗口；Python/Node 仍拥有进程账号权限，工作目录不是操作系统沙箱。

Agent 节点配置精确 target（agentAdapter、threadId）、source（sourceAgentType、sourceThreadId）与 briefRef。投递只走原适配器，丢响应查询原 deliveryId；正式回复的 result 使用 JSON `{ "status": "succeeded" }` 或 `{ "status": "failed", "reason": "…" }`。接收回执不作为完成；可用 independentFromNodeId 约束核验者与作者不是同一任务。

generate 使用原媒体拥有者提交 command 或观察已有 jobId，等待原 job 的终结回执；不另存第二套媒体任务状态。human 通过原 attemptId、检查人身份及证据提交，使用同一产物验证器。

## 产物与恢复

requirements 声明 key、root、相对 path、type=file、required、minCount 与 freshness。只支持文件名中的单层 `*`；每个必需声明都须满足。produced 比较执行前后的稳定摘要；旧文件、空目录、缺少任一必需产物均不通过。相同内容重写没有本次写入证明时不视为新产物；纯检查命令使用 validationOnly、输入引用和 validated。

运行冻结图、配置、变量、模板解析结果、绑定与输入摘要。续跑创建新 run，核对旧 attempt 和现有产物哈希；配置或输入改变会使受影响后继失效。停止先等待宿主进程退出；超过 3 秒未核实则保留待核实状态。重启后仅按原记录查询，存活不明时保留资源锁，不自动重跑。

项目和画布 API 位于 `/api/video/v2/projects`；运行位于 `/api/video/v2/runs`，沿用原 Manager 鉴权并进入统一操作目录。日志以 sequence 游标增量读取。产物只能用所属 run 和 opaque artifactId 读取，重新检查归属、根路径和哈希；主动内容按下载处理。

## 当前验收范围

新增测试覆盖独立画布 CAS、迁移中断恢复、材料目录复制、5000 张画布摘要分页、DAG/参数拒绝、真实 Node 命令产物、失败传播、续跑、幂等、取消和原 Agent 回执查询。模板、并发和媒体拥有者桥另有匹配测试。

真实早报 15 节点和 3 个 Agent、后续制作/审片/投稿、跨机执行权移交、完整安装及定时接入仍分别验收。旧早报流程保持正式真源；导入只产生定义和转换缺口报告，不执行流程。定时与事件触发尚未接入新画布。
