import type { ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";
import { isNapcatMirrorPrefix } from "./napcatWebuiMetadataViews.js";

export type NapcatWebuiManagementDescriptor = Readonly<{
  id: string; method: "GET" | "POST"; nativePath: string; params: ApiSchema; response: ApiSchema; binding: string;
  effects: string; description: string; sourceLines: { route: number; handlers: readonly number[] };
}>;

/** Credential transport accepts only these declared native shapes and bootstrap/readback calls. */
export function assertNapcatWebuiManagementRequest(method: string, pathname: string, body: Record<string, unknown>): void {
  const invalid = () => { throw new Error("NAPCAT_WEBUI_MANAGEMENT_REQUEST_INVALID"); };
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid();
  if (!pathname.startsWith("/api/") || /[?#\\]/.test(pathname)) invalid();
  const bootstrap = method === "POST" && ["/api/QQLogin/CheckLoginStatus", "/api/QQLogin/GetQQLoginInfo"].includes(pathname);
  const readback = method === "GET" && pathname === "/api/base/Theme";
  const descriptor = napcatWebuiManagementDescriptors.find(item => item.method === method && item.nativePath === pathname);
  if (!bootstrap && !readback && !descriptor) invalid();
  const allowed = pathname === "/api/QQLogin/SetQuickLoginQQ" ? ["uin"] : pathname === "/api/base/SetTheme" ? ["theme"]
    : pathname === "/api/QQLogin/ComputeLinuxGUID" ? ["mac", "machineId"] : pathname === "/api/Mirror/SetCustom" ? ["mirror"] : [];
  if (Object.keys(body).some(key => !allowed.includes(key))) invalid();
  if (pathname === "/api/Mirror/SetCustom" && !isNapcatMirrorPrefix(body.mirror)) invalid();
  if (pathname === "/api/QQLogin/SetQuickLoginQQ" && (typeof body.uin !== "string" || body.uin !== "" && !/^[0-9]{5,20}$/.test(body.uin))) invalid();
  if (pathname === "/api/base/SetTheme" && (!body.theme || typeof body.theme !== "object" || Array.isArray(body.theme))) invalid();
  if (pathname === "/api/QQLogin/ComputeLinuxGUID" && Object.values(body).some(value => typeof value !== "string" || value.length > 256)) invalid();
}

/** Fixed 4.18.4 management contracts. Native credentials and paths are owned by the configured instance. */
export const napcatWebuiManagementDescriptors: readonly NapcatWebuiManagementDescriptor[] = [
  {
    "id": "webui-config",
    "method": "GET",
    "nativePath": "/api/WebUIConfig/GetConfig",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "host": {
          "type": "string",
          "maxLength": 256
        },
        "port": {
          "type": "integer",
          "minimum": 1,
          "maximum": 65535
        },
        "loginRate": {
          "type": "integer",
          "minimum": 1
        },
        "disableWebUI": {
          "type": "boolean"
        },
        "accessControlMode": {
          "enum": [
            "none",
            "whitelist",
            "blacklist"
          ]
        },
        "ipWhitelist": {
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 256
          }
        },
        "ipBlacklist": {
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 256
          }
        },
        "enableXForwardedFor": {
          "type": "boolean"
        }
      },
      "required": [
        "host",
        "port",
        "loginRate",
        "disableWebUI",
        "accessControlMode",
        "ipWhitelist",
        "ipBlacklist",
        "enableXForwardedFor"
      ]
    },
    "binding": "management-bootstrap",
    "effects": "none",
    "description": "Returns only the native eight explicit config fields; no token/cert data.",
    "sourceLines": {
      "route": 92201,
      "handlers": [
        92007
      ]
    }
  },
  {
    "id": "webui-disabled",
    "method": "GET",
    "nativePath": "/api/WebUIConfig/GetDisableWebUI",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "disabled": {
          "type": "boolean"
        }
      },
      "required": [
        "disabled"
      ]
    },
    "binding": "management-bootstrap",
    "effects": "none",
    "description": "Native boolean result.",
    "sourceLines": {
      "route": 92203,
      "handlers": [
        92025
      ]
    }
  },
  {
    "id": "webui-client-ip",
    "method": "GET",
    "nativePath": "/api/WebUIConfig/GetClientIP",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ip": {
          "type": "string",
          "maxLength": 256
        }
      },
      "required": [
        "ip"
      ]
    },
    "binding": "management-bootstrap",
    "effects": "none",
    "description": "Forwarded header is supplied by the native transport, never a caller-controlled operation parameter.",
    "sourceLines": {
      "route": 92205,
      "handlers": [
        92047
      ]
    }
  },
  {
    "id": "onebot-config",
    "method": "POST",
    "nativePath": "/api/OB11Config/GetConfig",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "configDigest": {
          "type": "string",
          "maxLength": 256
        },
        "network": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "httpServers": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "name": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "enable": {
                    "type": "boolean"
                  },
                  "host": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "port": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "urlOrigin": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "tokenPresent": {
                    "type": "boolean"
                  },
                  "messagePostFormat": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "reportSelfMessage": {
                    "type": "boolean"
                  },
                  "debug": {
                    "type": "boolean"
                  },
                  "heartInterval": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "tokenPresent"
                ]
              }
            },
            "httpSseServers": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "name": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "enable": {
                    "type": "boolean"
                  },
                  "host": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "port": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "urlOrigin": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "tokenPresent": {
                    "type": "boolean"
                  },
                  "messagePostFormat": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "reportSelfMessage": {
                    "type": "boolean"
                  },
                  "debug": {
                    "type": "boolean"
                  },
                  "heartInterval": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "tokenPresent"
                ]
              }
            },
            "httpClients": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "name": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "enable": {
                    "type": "boolean"
                  },
                  "host": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "port": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "urlOrigin": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "tokenPresent": {
                    "type": "boolean"
                  },
                  "messagePostFormat": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "reportSelfMessage": {
                    "type": "boolean"
                  },
                  "debug": {
                    "type": "boolean"
                  },
                  "heartInterval": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "tokenPresent"
                ]
              }
            },
            "websocketServers": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "name": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "enable": {
                    "type": "boolean"
                  },
                  "host": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "port": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "urlOrigin": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "tokenPresent": {
                    "type": "boolean"
                  },
                  "messagePostFormat": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "reportSelfMessage": {
                    "type": "boolean"
                  },
                  "debug": {
                    "type": "boolean"
                  },
                  "heartInterval": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "tokenPresent"
                ]
              }
            },
            "websocketClients": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "name": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "enable": {
                    "type": "boolean"
                  },
                  "host": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "port": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "urlOrigin": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "tokenPresent": {
                    "type": "boolean"
                  },
                  "messagePostFormat": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "reportSelfMessage": {
                    "type": "boolean"
                  },
                  "debug": {
                    "type": "boolean"
                  },
                  "heartInterval": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "tokenPresent"
                ]
              }
            },
            "plugins": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "name": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "enable": {
                    "type": "boolean"
                  },
                  "host": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "port": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "urlOrigin": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "tokenPresent": {
                    "type": "boolean"
                  },
                  "messagePostFormat": {
                    "type": "string",
                    "maxLength": 256
                  },
                  "reportSelfMessage": {
                    "type": "boolean"
                  },
                  "debug": {
                    "type": "boolean"
                  },
                  "heartInterval": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "tokenPresent"
                ]
              }
            }
          }
        },
        "enableLocalFile2Url": {
          "type": "boolean"
        },
        "parseMultMsg": {
          "type": "boolean"
        },
        "musicSignOrigin": {
          "type": "string",
          "maxLength": 256
        },
        "imageDownloadProxyOrigin": {
          "type": "string",
          "maxLength": 256
        },
        "timeout": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "baseTimeout": {
              "type": "integer",
              "minimum": 0
            },
            "uploadSpeedKBps": {
              "type": "integer",
              "minimum": 0
            },
            "downloadSpeedKBps": {
              "type": "integer",
              "minimum": 0
            },
            "maxTimeout": {
              "type": "integer",
              "minimum": 0
            }
          }
        }
      },
      "required": [
        "configDigest",
        "network"
      ]
    },
    "binding": "login-required",
    "effects": "none",
    "description": "Native config parse is authoritative; token values and URL credentials/query are removed.",
    "sourceLines": {
      "route": 70851,
      "handlers": [
        70708
      ]
    }
  },
  {
    "id": "platform",
    "method": "POST",
    "nativePath": "/api/QQLogin/GetPlatformInfo",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "platform": {
          "type": "string",
          "maxLength": 256
        }
      },
      "required": [
        "platform"
      ]
    },
    "binding": "management-bootstrap",
    "effects": "none",
    "description": "Actual os.platform() result.",
    "sourceLines": {
      "route": 71667,
      "handlers": [
        71498
      ]
    }
  },
  {
    "id": "login-qr",
    "method": "POST",
    "nativePath": "/api/QQLogin/GetQQLoginQrcode",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "available": {
          "type": "boolean"
        },
        "payloadFingerprint": {
          "type": "string",
          "maxLength": 256
        },
        "relatedOperation": {
          "const": "manager.napcat.login-panel"
        }
      },
      "required": [
        "available",
        "relatedOperation"
      ]
    },
    "binding": "login-required-false",
    "effects": "login-challenge-read",
    "description": "Exact fixed QQLogin getter. Protected QR rendering stays with the original login panel.",
    "sourceLines": {
      "route": 71649,
      "handlers": [
        71270
      ]
    }
  },
  {
    "id": "quick-login-legacy",
    "method": "POST",
    "nativePath": "/api/QQLogin/GetQuickLoginList",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "userIds": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[0-9]{5,20}$"
          }
        },
        "invalidItems": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "userIds",
        "invalidItems"
      ]
    },
    "binding": "management-bootstrap",
    "effects": "none",
    "description": "Native startup stores list.map(item=>item.uin.toString()) at bundle line 116709. This is the legacy string list, not the new rich list.",
    "sourceLines": {
      "route": 71646,
      "handlers": [
        71313
      ]
    }
  },
  {
    "id": "quick-login-preference",
    "method": "POST",
    "nativePath": "/api/QQLogin/GetQuickLoginQQ",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "userId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[0-9]{5,20}$"
            },
            {
              "const": ""
            }
          ]
        }
      },
      "required": [
        "userId"
      ]
    },
    "binding": "management-bootstrap",
    "effects": "none",
    "description": "Native config autoLoginAccount string.",
    "sourceLines": {
      "route": 71652,
      "handlers": [
        71334
      ]
    }
  },
  {
    "id": "windows-guid",
    "method": "POST",
    "nativePath": "/api/QQLogin/GetDeviceGUID",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "present": {
          "type": "boolean"
        },
        "fingerprint256": {
          "type": "string",
          "maxLength": 256
        }
      },
      "required": [
        "present"
      ]
    },
    "binding": "windows-native-file",
    "effects": "read-protected-identity",
    "description": "Registry20 read requires win32 DPAPI and an initialized QQ data path/file. Return fingerprint; no file path or GUID plaintext.",
    "sourceLines": {
      "route": 71662,
      "handlers": [
        71429
      ]
    }
  },
  {
    "id": "windows-guid-backups",
    "method": "POST",
    "nativePath": "/api/QQLogin/GetGUIDBackups",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "backupName": {
                "type": "string",
                "maxLength": 256
              }
            },
            "required": [
              "backupName"
            ]
          }
        },
        "invalidItems": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "items",
        "invalidItems"
      ]
    },
    "binding": "qq-data-path",
    "effects": "read-backup-metadata",
    "description": "Native returns basename strings. Future restore validates exact membership, no path input.",
    "sourceLines": {
      "route": 71664,
      "handlers": [
        71455
      ]
    }
  },
  {
    "id": "linux-mac",
    "method": "POST",
    "nativePath": "/api/QQLogin/GetLinuxMAC",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "present": {
          "type": "boolean"
        },
        "fingerprint256": {
          "type": "string",
          "maxLength": 256
        }
      },
      "required": [
        "present"
      ]
    },
    "binding": "native-machine-info-file",
    "effects": "read-protected-identity",
    "description": "machine-info derives from original QQ data path. Native checks file length and decodes ROT13 ASCII.",
    "sourceLines": {
      "route": 71668,
      "handlers": [
        71501
      ]
    }
  },
  {
    "id": "linux-machine-id",
    "method": "POST",
    "nativePath": "/api/QQLogin/GetLinuxMachineId",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "present": {
          "type": "boolean"
        },
        "fingerprint256": {
          "type": "string",
          "maxLength": 256
        }
      },
      "required": [
        "present"
      ]
    },
    "binding": "linux-machine-id-file",
    "effects": "read-protected-identity",
    "description": "Native reads /etc/machine-id. Missing file is an explicit platform/runtime dependency.",
    "sourceLines": {
      "route": 71670,
      "handlers": [
        71527
      ]
    }
  },
  {
    "id": "linux-guid-compute",
    "method": "POST",
    "nativePath": "/api/QQLogin/ComputeLinuxGUID",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "mac": {
          "type": "string",
          "maxLength": 256,
          "writeOnly": true
        },
        "machineId": {
          "type": "string",
          "maxLength": 256,
          "writeOnly": true
        }
      }
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "guidFingerprint256": {
          "type": "string",
          "maxLength": 256
        },
        "inputSource": {
          "enum": [
            "explicit",
            "native-file"
          ]
        },
        "nativeIdentityExposed": {
          "const": false
        }
      },
      "required": [
        "guidFingerprint256",
        "inputSource",
        "nativeIdentityExposed"
      ]
    },
    "binding": "explicit-or-native-file",
    "effects": "conditional-protected-read",
    "description": "With both explicit strings, native MD5(machineId+mac) computes without file access. Missing fields read native files; empty-string fallback is not accepted as a valid native identity.",
    "sourceLines": {
      "route": 71671,
      "handlers": [
        71535
      ]
    }
  },
  {
    "id": "linux-machine-backups",
    "method": "POST",
    "nativePath": "/api/QQLogin/GetLinuxMachineInfoBackups",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "backupName": {
                "type": "string",
                "maxLength": 256
              }
            },
            "required": [
              "backupName"
            ]
          }
        },
        "invalidItems": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "items",
        "invalidItems"
      ]
    },
    "binding": "qq-data-path",
    "effects": "read-backup-metadata",
    "description": "Native returns basename strings beginning machine-info.bak.",
    "sourceLines": {
      "route": 71672,
      "handlers": [
        71561
      ]
    }
  },
  {
    "id": "quick-login-preference.set",
    "method": "POST",
    "nativePath": "/api/QQLogin/SetQuickLoginQQ",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "userId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[0-9]{5,20}$"
            },
            {
              "const": ""
            }
          ]
        }
      },
      "required": [
        "userId"
      ]
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "applied": {
          "type": "boolean"
        },
        "afterDigest": {
          "type": "string",
          "maxLength": 256
        }
      },
      "required": [
        "applied",
        "afterDigest"
      ]
    },
    "binding": "management-bootstrap",
    "effects": "configuration-mutation",
    "description": "Native persists autoLoginAccount; it does not initiate quick login. Nonempty userId must match an existing bound account when one is configured.",
    "sourceLines": {
      "route": 71653,
      "handlers": [
        71338
      ]
    }
  },
  {
    "id": "theme.set",
    "method": "POST",
    "nativePath": "/api/base/SetTheme",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "theme": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "fontMode": {
              "type": "string",
              "maxLength": 256
            },
            "dark": {
              "type": "object",
              "additionalProperties": {
                "type": "string",
                "maxLength": 4096
              }
            },
            "light": {
              "type": "object",
              "additionalProperties": {
                "type": "string",
                "maxLength": 4096
              }
            }
          },
          "required": [
            "fontMode",
            "dark",
            "light"
          ]
        }
      },
      "required": [
        "theme"
      ]
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "applied": {
          "type": "boolean"
        },
        "afterDigest": {
          "type": "string",
          "maxLength": 256
        }
      },
      "required": [
        "applied",
        "afterDigest"
      ]
    },
    "binding": "management-bootstrap",
    "effects": "configuration-mutation",
    "description": "Native merges/persists theme. The actual declared theme is fontMode plus dark/light string records.",
    "sourceLines": {
      "route": 90538,
      "handlers": [
        90479
      ]
    }
  },
  {
    "id": "napcat-global-config",
    "method": "GET",
    "nativePath": "/api/NapCatConfig/GetConfig",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "scope": {
          "enum": [
            "global",
            "native-current-qq"
          ]
        },
        "config": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "fileLog": {
              "type": "boolean"
            },
            "consoleLog": {
              "type": "boolean"
            },
            "fileLogLevel": {
              "type": "string"
            },
            "consoleLogLevel": {
              "type": "string"
            },
            "packetBackend": {
              "type": "string"
            },
            "o3HookMode": {
              "type": "number"
            },
            "autoTimeSync": {
              "type": "boolean"
            },
            "bypass": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "hook": {
                  "type": "boolean"
                },
                "window": {
                  "type": "boolean"
                },
                "module": {
                  "type": "boolean"
                },
                "process": {
                  "type": "boolean"
                },
                "container": {
                  "type": "boolean"
                },
                "js": {
                  "type": "boolean"
                }
              }
            }
          }
        },
        "packetServer": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "present": {
              "type": "boolean"
            },
            "valueType": {
              "enum": [
                "string",
                "number",
                "boolean",
                "object",
                "array",
                "null",
                "undefined"
              ]
            },
            "length": {
              "type": "integer",
              "minimum": 0
            }
          },
          "required": [
            "present",
            "valueType"
          ]
        },
        "invalidFields": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "omittedUnknownFieldCount": {
          "type": "integer",
          "minimum": 0
        },
        "view": {
          "const": "restricted-native-config-metadata"
        },
        "sourceProvenance": {
          "const": "native-api-does-not-identify-file-or-default-fallback"
        },
        "runtimeApplied": {
          "const": "not-proven"
        }
      },
      "required": [
        "scope",
        "config",
        "packetServer",
        "invalidFields",
        "omittedUnknownFieldCount",
        "view",
        "sourceProvenance",
        "runtimeApplied"
      ]
    },
    "binding": "management-bootstrap",
    "effects": "read-metadata",
    "description": "Restricted nine-field config metadata. Eight declared typed fields preserve native semantics; packetServer has only type/presence/length because value semantics are unverified, with no claim that the field is a credential. Native silent default/file fallback and runtime adoption are not inferred.",
    "sourceLines": {
      "route": 96535,
      "handlers": [
        96457,
        96441,
        60588
      ]
    }
  },
  {
    "id": "napcat-account-config",
    "method": "GET",
    "nativePath": "/api/NapCatConfig/GetUinConfig",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "scope": {
          "enum": [
            "global",
            "native-current-qq"
          ]
        },
        "config": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "fileLog": {
              "type": "boolean"
            },
            "consoleLog": {
              "type": "boolean"
            },
            "fileLogLevel": {
              "type": "string"
            },
            "consoleLogLevel": {
              "type": "string"
            },
            "packetBackend": {
              "type": "string"
            },
            "o3HookMode": {
              "type": "number"
            },
            "autoTimeSync": {
              "type": "boolean"
            },
            "bypass": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "hook": {
                  "type": "boolean"
                },
                "window": {
                  "type": "boolean"
                },
                "module": {
                  "type": "boolean"
                },
                "process": {
                  "type": "boolean"
                },
                "container": {
                  "type": "boolean"
                },
                "js": {
                  "type": "boolean"
                }
              }
            }
          }
        },
        "packetServer": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "present": {
              "type": "boolean"
            },
            "valueType": {
              "enum": [
                "string",
                "number",
                "boolean",
                "object",
                "array",
                "null",
                "undefined"
              ]
            },
            "length": {
              "type": "integer",
              "minimum": 0
            }
          },
          "required": [
            "present",
            "valueType"
          ]
        },
        "invalidFields": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "omittedUnknownFieldCount": {
          "type": "integer",
          "minimum": 0
        },
        "view": {
          "const": "restricted-native-config-metadata"
        },
        "sourceProvenance": {
          "const": "native-api-does-not-identify-file-or-default-fallback"
        },
        "runtimeApplied": {
          "const": "not-proven"
        }
      },
      "required": [
        "scope",
        "config",
        "packetServer",
        "invalidFields",
        "omittedUnknownFieldCount",
        "view",
        "sourceProvenance",
        "runtimeApplied"
      ]
    },
    "binding": "login-required",
    "effects": "read-metadata",
    "description": "Same restricted config view for the observed native current QQ. Exact configured QQ and native login identity are verified before and after the native read. Native per-QQ/global/default fallback is not exposed by the native API and is not guessed.",
    "sourceLines": {
      "route": 96537,
      "handlers": [
        96506,
        96488,
        60588
      ]
    }
  },
  {
    "id": "webui-font-exists",
    "method": "GET",
    "nativePath": "/api/File/font/exists/webui",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "exists": {
          "type": "boolean"
        }
      },
      "required": [
        "exists"
      ]
    },
    "binding": "management-bootstrap",
    "effects": "read-metadata",
    "description": "Read the native fixed WebUI font existence result. No caller path, file content or actual filename is exposed. Only a successful native boolean false proves absence.",
    "sourceLines": {
      "route": 92005,
      "handlers": [
        91970,
        63512,
        63518
      ]
    }
  },
  {
    "id": "mirror-list",
    "method": "GET",
    "nativePath": "/api/Mirror/List",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "fileMirrors": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "index": {
                "type": "integer",
                "minimum": 0
              },
              "direct": {
                "type": "boolean"
              },
              "origin": {
                "type": "string"
              },
              "hasUserinfo": {
                "type": "boolean"
              },
              "hasQuery": {
                "type": "boolean"
              },
              "hasFragment": {
                "type": "boolean"
              },
              "limitedDisplay": {
                "const": true
              },
              "executable": {
                "const": false
              },
              "pathPresent": {
                "type": "boolean"
              },
              "pathLength": {
                "type": "integer",
                "minimum": 0
              }
            },
            "required": [
              "index",
              "direct",
              "limitedDisplay",
              "executable",
              "pathPresent",
              "pathLength"
            ]
          }
        },
        "rawMirrors": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "index": {
                "type": "integer",
                "minimum": 0
              },
              "direct": {
                "type": "boolean"
              },
              "origin": {
                "type": "string"
              },
              "hasUserinfo": {
                "type": "boolean"
              },
              "hasQuery": {
                "type": "boolean"
              },
              "hasFragment": {
                "type": "boolean"
              },
              "limitedDisplay": {
                "const": true
              },
              "executable": {
                "const": false
              },
              "pathPresent": {
                "type": "boolean"
              },
              "pathLength": {
                "type": "integer",
                "minimum": 0
              }
            },
            "required": [
              "index",
              "direct",
              "limitedDisplay",
              "executable",
              "pathPresent",
              "pathLength"
            ]
          }
        },
        "customMirror": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "index": {
                  "type": "integer",
                  "minimum": 0
                },
                "direct": {
                  "type": "boolean"
                },
                "origin": {
                  "type": "string"
                },
                "hasUserinfo": {
                  "type": "boolean"
                },
                "hasQuery": {
                  "type": "boolean"
                },
                "hasFragment": {
                  "type": "boolean"
                },
                "limitedDisplay": {
                  "const": true
                },
                "executable": {
                  "const": false
                },
                "pathPresent": {
                  "type": "boolean"
                },
                "pathLength": {
                  "type": "integer",
                  "minimum": 0
                }
              },
              "required": [
                "index",
                "direct",
                "limitedDisplay",
                "executable",
                "pathPresent",
                "pathLength"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "invalidItems": {
          "type": "integer",
          "minimum": 0
        },
        "timeoutMs": {
          "type": "number",
          "minimum": 0
        },
        "timeoutValid": {
          "type": "boolean"
        },
        "view": {
          "const": "limited-native-mirror-display"
        },
        "executable": {
          "const": false
        }
      },
      "required": [
        "fileMirrors",
        "rawMirrors",
        "customMirror",
        "invalidItems",
        "timeoutValid",
        "view",
        "executable"
      ]
    },
    "binding": "management-bootstrap",
    "effects": "read-metadata",
    "description": "Return native mirror priority and origin with path presence/length metadata. Full prefix values, including potentially private path segments, remain held by the original native configuration owner. Userinfo/query/fragment are omitted. This metadata is not an executable mirror target; caller URL input is rejected.",
    "sourceLines": {
      "route": 96429,
      "handlers": [
        96318,
        10597,
        10603
      ]
    }
  },
  {
    "id": "mirror-custom.set",
    "method": "POST",
    "nativePath": "/api/Mirror/SetCustom",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "mirror"
      ],
      "properties": {
        "mirror": {
          "type": "string",
          "writeOnly": true,
          "description": "Explicit HTTP/S mirror prefix passed verbatim to the native configuration setter. Empty clears the preference. Paths/query/userinfo stay in request memory and the original native config owner."
        }
      }
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "applied",
        "afterDigest",
        "prefixMetadata",
        "effectScope"
      ],
      "properties": {
        "applied": {
          "const": true
        },
        "afterDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "prefixMetadata": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "direct",
            "pathPresent",
            "pathLength",
            "limitedDisplay",
            "executable"
          ],
          "properties": {
            "direct": {
              "type": "boolean"
            },
            "origin": {
              "type": "string"
            },
            "pathPresent": {
              "type": "boolean"
            },
            "pathLength": {
              "type": "integer",
              "minimum": 0
            },
            "hasUserinfo": {
              "type": "boolean"
            },
            "hasQuery": {
              "type": "boolean"
            },
            "hasFragment": {
              "type": "boolean"
            },
            "limitedDisplay": {
              "const": true
            },
            "executable": {
              "const": false
            }
          }
        },
        "effectScope": {
          "const": "selected-native-process-memory"
        }
      }
    },
    "binding": "management-bootstrap",
    "effects": "configuration-mutation",
    "description": "Set or clear the exact native process-memory mirror prefix. HTTP/S input may contain path/query and is forwarded unchanged to the fixed native config endpoint, without hostname restrictions. Results/owner audit/receipt retain only digest and limited metadata. The native setter does not persist to disk or provide cross-client atomic CAS.",
    "sourceLines": {
      "route": 96430,
      "handlers": [
        96331,
        10600,
        10593,
        10603
      ]
    }
  }
];
