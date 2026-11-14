export const assistantPanelStyles = `
.va-panel,.va-settings{--va-line:var(--dsw-alias-border,#31454f);--va-muted:var(--dsw-alias-text-secondary,#9fb3bd);--va-accent:#69d6bd;--va-surface:var(--dsw-alias-background-primary,#101c24);font-size:14px;line-height:1.5}
.va-panel *,.va-settings *{box-sizing:border-box}
.va-settings{display:flex;flex-direction:column;height:min(74dvh,820px);min-height:320px;max-width:1040px;margin:auto;gap:0!important;padding:0!important}
.va-nav{display:flex;gap:4px;padding:12px 20px;border-bottom:1px solid var(--va-line);flex-shrink:0}
.va-nav button{flex:1;padding:10px 14px;border:0;border-radius:7px;background:transparent;color:var(--va-muted)}
.va-nav button[aria-pressed=true]{background:#25463f;color:#c0f8e9;font-weight:650}
.va-pages{border:0;margin:0;min-width:0;min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;padding:24px;scrollbar-gutter:stable}
.va-pages [hidden]{display:none!important}
.va-pages fieldset{border:1px solid var(--va-line);border-radius:12px;padding:20px;margin:0;min-width:0}
.va-pages legend{font-size:15px;font-weight:650;padding:0 7px}
.va-pages input:not([type=checkbox]),.va-pages select,.va-pages textarea{width:100%;min-width:0;border:1px solid var(--va-line);border-radius:7px;background:var(--dsw-alias-background-secondary,#14242d);color:inherit;padding:9px 11px;font:inherit;font-weight:400}
.va-pages input:focus-visible,.va-pages select:focus-visible,.va-pages textarea:focus-visible,.va-settings button:focus-visible,.va-pages summary:focus-visible{outline:2px solid var(--va-accent);outline-offset:2px}
.va-pages input[aria-invalid=true]{border-color:#ed9e92}
.va-pages :disabled{opacity:.5;cursor:not-allowed}
.va-pages input[type=checkbox]{width:17px;height:17px;accent-color:var(--va-accent);flex-shrink:0}
.va-pages label{font-size:13px;font-weight:550}
.va-pages p,.va-pages small{color:var(--va-muted);font-weight:400}
.va-pages p{font-size:13px;line-height:1.65}
.va-segments{display:flex;gap:4px;width:fit-content;padding:4px;background:var(--dsw-alias-background-secondary,#14242d);border-radius:9px}
.va-segments button{border:0;background:transparent;color:var(--va-muted);padding:9px 20px;border-radius:6px}
.va-segments button[aria-pressed=true]{background:#31574f;color:#defdf3}
.va-service>.va-provider{max-width:100%;margin-bottom:18px!important}
.va-model-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}
.va-model-grid>label:first-child,.va-model-grid>p,.va-model-grid>details{grid-column:1/-1}
.va-model-grid>details{padding:0 0 10px}
.va-basic-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}
.va-basic-grid .va-model-grid{display:contents}.va-basic-grid .va-model-grid>label:first-child{grid-column:auto}
.va-credential{padding:16px;background:var(--dsw-alias-background-secondary,#14242d);border:1px solid var(--va-line);border-radius:9px;margin:16px 0 24px!important}
.va-credential label{margin:0!important;flex:1}
.va-credential-line{display:flex;align-items:flex-end;gap:10px}
.va-credential-line button{white-space:nowrap;min-height:40px}
.va-credential small{display:block;margin-top:8px}
.va-credential>summary{font-size:13px;font-weight:550;color:var(--va-muted);cursor:pointer}.va-credential[open]>summary{margin-bottom:12px}
.va-setup{border:1px solid var(--va-line);border-radius:10px;padding:16px 18px;background:var(--dsw-alias-background-secondary,#14242d)}
.va-setup strong{display:block;font-size:14px;margin-bottom:10px;font-weight:550}.va-setup button{font-size:12px;background:transparent;padding:7px 10px;min-height:34px}
.va-settings-footer>div{justify-content:flex-end}.va-settings-footer:has(>div)>p{max-width:35%}
.va-parameter-toolbar{display:flex;align-items:flex-end;gap:16px;margin:0 0 12px;flex-wrap:wrap}
.va-parameter-toolbar>label:first-child{flex:1;min-width:180px;margin:0!important}
.va-parameter-toolbar .va-identifiers{display:flex;gap:7px;align-items:center;margin-bottom:10px;white-space:nowrap;font-weight:400;font-size:12px;color:var(--va-muted)}
.va-group{border:1px solid var(--va-line);border-radius:9px;margin-top:9px;overflow:hidden}
.va-group>summary{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;cursor:pointer;list-style:none;font-size:14px;font-weight:600}
.va-group>summary:after{content:'+';color:var(--va-muted);font-size:18px;font-weight:400;margin-left:12px}
.va-group[open]>summary:after{content:'−'}
.va-group>summary .va-count{margin-left:auto;color:var(--va-muted);font-size:12px;font-weight:400}
.va-group[open]>summary{border-bottom:1px solid var(--va-line)}
.va-parameter-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 24px;padding:4px 16px 12px}
.va-parameter{min-width:0;padding:14px 0;border-bottom:1px solid var(--va-line)}
.va-parameter-wide{grid-column:1/-1}
.va-parameter label{margin-bottom:6px!important}
.va-parameter small{font-size:12px;line-height:1.55;display:block}
.va-parameter code{display:block;overflow-wrap:anywhere;color:var(--va-muted);font-size:11px;margin-top:6px}
.va-parameter[data-enabled=false]{background:transparent}
.va-default{opacity:.75;margin-top:5px}
.va-note{margin-top:7px}
.va-disabled{color:#c8ad79!important;margin-top:6px}
.va-error{color:#ffb4ab!important}
.va-voice-picker{border-top:1px solid var(--va-line);padding-top:18px;margin-top:12px}
.va-voice-picker small{display:block;margin:4px 0 10px}
.va-advanced{border-top:1px solid var(--va-line);padding-top:10px;margin-top:18px}
.va-pages summary{cursor:pointer}
.va-settings-footer{flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 24px;border-top:1px solid var(--va-line);background:var(--va-surface)}
.va-settings-footer p{font-size:13px;margin:0;color:var(--va-muted);max-width:65%;overflow-wrap:anywhere}
.va-settings-footer button{flex-shrink:0}
.va-primary{background:#67cdb5!important;border-color:#67cdb5!important;color:#09241c!important;font-weight:650}
.va-primary:disabled{opacity:.45}
.va-status{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--va-muted)}
.va-status:before{content:'';width:7px;height:7px;border-radius:50%;background:#778e98}
.va-status[data-running=true]:before{background:var(--va-accent)}
.va-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:16px 0;border-bottom:1px solid var(--va-line)}
.va-conversation{min-height:240px;max-height:50vh;overflow:auto;padding:22px 0}
.va-empty{padding:48px 16px;text-align:center;color:var(--va-muted)}
.va-empty strong{display:block;font-size:18px;color:inherit;font-weight:550;margin-bottom:8px}
.va-compose{display:flex;gap:10px}.va-compose input{flex:1;min-width:0}
.va-message{padding:12px 16px;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:10px;max-width:88%;margin:8px 0;background:var(--dsw-alias-background-secondary,#14242d)}
.va-message[data-role=user]{margin-left:auto;background:#203c38}
.va-preview strong,.va-preview span{display:block}.va-preview p{margin:6px 0 10px}.va-preview a{color:var(--va-accent);font-weight:600}.va-preview-settings{margin:12px 20px 0;flex-shrink:0}.va-help{margin:0 0 18px;padding:10px 12px;border-left:2px solid var(--va-accent)}.va-setup-steps{list-style:none;padding:0;margin:12px 0 0;display:grid;gap:0}.va-setup-steps li{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--va-line)}.va-setup-steps strong{margin:0}.va-setup-steps p{margin:4px 0 0;color:var(--va-muted);font-size:13px}.va-setup-steps button{white-space:nowrap;flex-shrink:0}.va-preview{border:1px solid var(--va-line);border-radius:8px;padding:9px 12px;font-size:12px;color:var(--va-muted)}
@media(max-width:620px){.va-settings{height:calc(92dvh - 72px);min-height:240px}.va-nav{padding:8px}.va-nav button{padding:9px 3px;font-size:12px;white-space:nowrap;min-width:0}.va-pages{padding:14px;scrollbar-gutter:auto}.va-pages fieldset{padding:14px}.va-model-grid,.va-basic-grid,.va-parameter-grid{grid-template-columns:1fr}.va-parameter-wide{grid-column:auto}.va-parameter-grid{padding:0 12px 10px;gap:0}.va-settings-footer{padding:12px 14px;flex-wrap:wrap}.va-settings-footer:has(>div)>p{max-width:100%;flex-basis:100%}.va-settings-footer>div{width:100%}.va-settings-footer>div button{flex:1;padding:9px 7px}.va-credential-line{flex-wrap:wrap}.va-credential-line label{flex-basis:100%}.va-parameter-toolbar .va-identifiers{margin-bottom:0}.va-message{max-width:96%}.va-segments{width:100%}.va-segments button{flex:1}}
@media(prefers-reduced-motion:no-preference){.va-settings button,.va-panel button{transition:background .15s,border-color .15s}.va-group[open] .va-parameter-grid{animation:va-reveal .16s ease-out}@keyframes va-reveal{from{opacity:.5;transform:translateY(-3px)}to{opacity:1;transform:none}}}
`;
