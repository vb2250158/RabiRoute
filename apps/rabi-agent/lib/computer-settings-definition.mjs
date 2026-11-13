// Generated from Core/assets/computer-settings.json. Edit the canonical definition, not this SDK bootstrap.
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
export const COMPUTER_SETTINGS_DEFINITION = freeze({
  "actions": {
    "annotation.clear": {
      "capability": "annotation",
      "feature": "annotation",
      "recovery": true
    },
    "annotation.show": {
      "capability": "annotation",
      "feature": "annotation",
      "receipt": true,
      "settingsPaths": [
        "annotation.staticDurationMs"
      ]
    },
    "annotation.status": {
      "capability": "annotation",
      "feature": "annotation",
      "readOnly": true,
      "recovery": true
    },
    "annotation.track.start": {
      "capability": "tracking",
      "dynamic": true,
      "feature": "annotation",
      "inputSettings": {
        "backend": "annotation.backend",
        "rateHz": "annotation.rateHz"
      },
      "receipt": true,
      "settingsPaths": [
        "annotation.dynamicEnabled",
        "annotation.backend",
        "annotation.rateHz",
        "annotation.tracking",
        "performance"
      ]
    },
    "annotation.track.status": {
      "capability": "tracking",
      "feature": "annotation",
      "readOnly": true,
      "recovery": true
    },
    "annotation.track.stop": {
      "capability": "tracking",
      "feature": "annotation",
      "recovery": true
    },
    "annotation.update": {
      "capability": "annotation",
      "feature": "annotation"
    },
    "control.begin": {
      "capability": "input",
      "feature": "input",
      "receipt": true,
      "settingsPaths": [
        "control"
      ]
    },
    "control.end": {
      "capability": "input",
      "feature": "input",
      "recovery": true
    },
    "control.status": {
      "capability": "input",
      "feature": "input",
      "readOnly": true,
      "recovery": true
    },
    "file.read": {
      "capability": "files",
      "feature": "files",
      "readOnly": true
    },
    "file.stat": {
      "capability": "files",
      "feature": "files",
      "readOnly": true
    },
    "input.cancel": {
      "capability": "input",
      "feature": "input",
      "recovery": true
    },
    "input.execute": {
      "capability": "input",
      "feature": "input",
      "receipt": true,
      "settingsPaths": [
        "input"
      ]
    },
    "input.status": {
      "capability": "input",
      "feature": "input",
      "readOnly": true,
      "recovery": true
    },
    "screen.capture": {
      "capability": "screenshots",
      "feature": "observation",
      "readOnly": true,
      "settingsPaths": [
        "annotation.tracking.frameCacheFrames",
        "annotation.tracking.frameCacheBytes",
        "annotation.tracking.frameCacheAgeMs"
      ]
    },
    "upload.abort": {
      "capability": "files",
      "feature": "files",
      "recovery": true
    },
    "upload.begin": {
      "capability": "files",
      "feature": "files"
    },
    "upload.commit": {
      "capability": "files",
      "feature": "files"
    },
    "upload.status": {
      "capability": "files",
      "feature": "files",
      "readOnly": true,
      "recovery": true
    },
    "upload.write": {
      "capability": "files",
      "feature": "files"
    },
    "windows.list": {
      "capability": "windows",
      "feature": "observation",
      "readOnly": true
    }
  },
  "features": {
    "agentTasks": {
      "description": "向这台电脑上的智能体分派工作",
      "title": "智能体任务"
    },
    "annotation": {
      "description": "显示框、箭头和文字，与鼠标键盘独立",
      "title": "屏幕标注"
    },
    "files": {
      "description": "查询文件和上传、下载",
      "title": "文件操作"
    },
    "input": {
      "description": "点击、输入文字、滚动、拖拽和快捷键",
      "title": "鼠标与键盘"
    },
    "observation": {
      "description": "查看窗口和电脑画面",
      "title": "窗口与截图"
    },
    "terminal": {
      "description": "运行命令和读取终端输出",
      "title": "终端命令"
    }
  },
  "schema": {
    "additionalProperties": true,
    "properties": {
      "annotation": {
        "additionalProperties": true,
        "properties": {
          "backend": {
            "default": "kcf",
            "enum": [
              "kcf",
              "template"
            ],
            "title": "跟踪方式",
            "type": "string"
          },
          "dynamicEnabled": {
            "default": false,
            "description": "持续处理会增加 CPU 占用；启用本身不创建跟踪任务",
            "title": "动态标注（持续跟踪目标）",
            "type": "boolean"
          },
          "rateHz": {
            "default": 10,
            "minimum": 5e-324,
            "title": "请求更新频率",
            "type": "number",
            "unit": "次/秒"
          },
          "staticDurationMs": {
            "anyOf": [
              {
                "minimum": 0,
                "type": "number"
              },
              {
                "type": "null"
              }
            ],
            "default": 10000,
            "description": "null 表示保留至清除",
            "title": "静态标注时长",
            "unit": "毫秒"
          },
          "tracking": {
            "additionalProperties": true,
            "advanced": true,
            "properties": {
              "ambiguityMargin": {
                "default": 0.05,
                "maximum": 1,
                "minimum": 0,
                "title": "相似目标差值",
                "type": "number"
              },
              "frameCacheAgeMs": {
                "default": 30000,
                "maximum": 300000,
                "minimum": 1000,
                "title": "来源帧缓存时长",
                "type": "number",
                "unit": "毫秒"
              },
              "frameCacheBytes": {
                "default": 134217728,
                "maximum": 1073741824,
                "minimum": 1048576,
                "title": "来源帧缓存大小",
                "type": "number",
                "unit": "字节"
              },
              "frameCacheFrames": {
                "default": 6,
                "maximum": 60,
                "minimum": 1,
                "title": "来源帧缓存",
                "type": "number",
                "unit": "帧"
              },
              "lostAfterFrames": {
                "default": 2,
                "maximum": 100,
                "minimum": 1,
                "title": "丢失判定",
                "type": "number",
                "unit": "帧"
              },
              "matchThreshold": {
                "default": 0.82,
                "maximum": 1,
                "minimum": 0,
                "title": "模板匹配阈值",
                "type": "number"
              },
              "maxAnalysisWidth": {
                "default": 1280,
                "maximum": 3840,
                "minimum": 320,
                "title": "分析最大宽度",
                "type": "number",
                "unit": "像素"
              },
              "predictionMs": {
                "default": 0,
                "maximum": 1000,
                "minimum": 0,
                "title": "预测范围",
                "type": "number",
                "unit": "毫秒"
              },
              "searchExpansion": {
                "default": 2,
                "maximum": 8,
                "minimum": 1,
                "title": "搜索扩展",
                "type": "number"
              },
              "smoothing": {
                "default": 0,
                "maximum": 1,
                "minimum": 0,
                "title": "平滑",
                "type": "number"
              },
              "updateTemplate": {
                "default": false,
                "title": "可靠时更新模板",
                "type": "boolean"
              },
              "verifyEveryFrames": {
                "default": 10,
                "maximum": 1000,
                "minimum": 1,
                "title": "模板核验间隔",
                "type": "number",
                "unit": "帧"
              }
            },
            "title": "跟踪高级设置",
            "type": "object"
          }
        },
        "title": "屏幕标注",
        "type": "object"
      },
      "control": {
        "additionalProperties": true,
        "properties": {
          "countdownSeconds": {
            "default": 10,
            "minimum": 0,
            "title": "倒计时显示",
            "type": "number",
            "unit": "秒"
          },
          "exitOnLocalInput": {
            "default": false,
            "title": "检测到本机主动操作时退出",
            "type": "boolean"
          },
          "exitShortcut": {
            "default": "Ctrl+Alt+Esc",
            "minLength": 1,
            "title": "退出控制快捷键",
            "type": "string"
          },
          "idleExitEnabled": {
            "default": true,
            "title": "空闲时自动退出",
            "type": "boolean"
          },
          "idleTimeoutSeconds": {
            "default": 120,
            "minimum": 5e-324,
            "title": "空闲退出时长",
            "type": "number",
            "unit": "秒"
          },
          "showPointer": {
            "default": true,
            "title": "控制时显示 Agent 指针",
            "type": "boolean"
          }
        },
        "title": "鼠标与键盘",
        "type": "object"
      },
      "enabled": {
        "default": true,
        "title": "启用此电脑",
        "type": "boolean"
      },
      "features": {
        "additionalProperties": true,
        "properties": {
          "agentTasks": {
            "default": true,
            "description": "向这台电脑上的智能体分派工作",
            "title": "智能体任务",
            "type": "boolean"
          },
          "annotation": {
            "default": true,
            "description": "显示框、箭头和文字，与鼠标键盘独立",
            "title": "屏幕标注",
            "type": "boolean"
          },
          "files": {
            "default": true,
            "description": "查询文件和上传、下载",
            "title": "文件操作",
            "type": "boolean"
          },
          "input": {
            "default": true,
            "description": "点击、输入文字、滚动、拖拽和快捷键",
            "title": "鼠标与键盘",
            "type": "boolean"
          },
          "observation": {
            "default": true,
            "description": "查看窗口和电脑画面",
            "title": "窗口与截图",
            "type": "boolean"
          },
          "terminal": {
            "default": true,
            "description": "运行命令和读取终端输出",
            "title": "终端命令",
            "type": "boolean"
          }
        },
        "title": "功能",
        "type": "object"
      },
      "input": {
        "additionalProperties": true,
        "advanced": true,
        "properties": {
          "maxActions": {
            "default": 128,
            "maximum": 4096,
            "minimum": 1,
            "title": "输入批次上限",
            "type": "number",
            "unit": "项"
          },
          "nativeSegmentMs": {
            "default": 16,
            "maximum": 100,
            "minimum": 1,
            "title": "原生输入分段预算",
            "type": "number",
            "unit": "毫秒"
          }
        },
        "title": "输入与恢复设置",
        "type": "object"
      },
      "performance": {
        "additionalProperties": true,
        "properties": {
          "computeBudgetMs": {
            "default": 20,
            "maximum": 1000,
            "minimum": 1,
            "title": "每轮计算预算",
            "type": "number",
            "unit": "毫秒"
          },
          "maxTargets": {
            "default": 8,
            "maximum": 64,
            "minimum": 1,
            "title": "跟踪目标预算",
            "type": "number",
            "unit": "个"
          },
          "memoryBudgetBytes": {
            "default": 536870912,
            "maximum": 2147483648,
            "minimum": 16777216,
            "title": "内存预算",
            "type": "number",
            "unit": "字节"
          },
          "minAnalysisWidth": {
            "default": 320,
            "minimum": 1,
            "title": "最低分析宽度",
            "type": "number",
            "unit": "像素"
          },
          "minRateHz": {
            "default": 2,
            "maximum": 30,
            "minimum": 1,
            "title": "最低频率",
            "type": "number",
            "unit": "次/秒"
          },
          "mode": {
            "default": "auto",
            "enum": [
              "auto",
              "custom"
            ],
            "title": "性能模式",
            "type": "string"
          }
        },
        "title": "性能与资源",
        "type": "object"
      }
    },
    "title": "电脑设置",
    "type": "object"
  },
  "schemaVersion": 1
});
export const COMPUTER_SETTINGS_DEFINITION_DIGEST = "dec9cf85ee89209ff7c85aed70eaac132b94eed1f553c8d3a41b8f92a0010183";
