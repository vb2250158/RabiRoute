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
.va-checks{border:1px solid var(--va-line);border-radius:14px;padding:20px;background:var(--va-surface)}
.va-check-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:16px}
.va-check-heading h2{font-size:18px;margin:0 0 5px}.va-check-heading p{color:var(--va-muted);margin:0;font-size:13px}
.va-check-heading button{min-height:44px;white-space:nowrap}
.va-check-summary{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.va-check-summary span{font-size:13px;border:1px solid var(--va-line);border-radius:6px;padding:6px 10px;color:#a5efcd;background:#1d3b32}
.va-check-toggle{background:transparent!important;color:var(--va-muted)!important;margin:0 0 12px;min-height:40px}
.va-check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.va-check-card{padding:16px;border:1px solid var(--va-line);border-radius:10px;min-width:0;display:flex;flex-direction:column;background:var(--dsw-alias-background-secondary,#14242d)}
.va-check-card:last-child{grid-column:1/-1}
.va-check-title{display:flex;align-items:center;justify-content:space-between;gap:10px}
.va-check-title h3{font-size:15px;margin:0;font-weight:600}
.va-check-badge{font-size:12px;padding:3px 9px;border-radius:6px;background:#293a44;color:#c0cdd4;white-space:nowrap}
.va-check-card[data-status=passed] .va-check-badge{background:#1d483b;color:#a5efcd}
.va-check-card[data-status=failed] .va-check-badge{background:#532d31;color:#ffb9b2}
.va-check-card[data-status=warning] .va-check-badge,.va-check-card[data-status=missing] .va-check-badge,.va-check-card[data-status=stale] .va-check-badge{background:#473c26;color:#f0d49a}
.va-check-card[data-status=running]{border-color:var(--va-accent)}
.va-check-card[data-status=running] .va-check-badge{background:#244d49;color:#b9f5e7}
.va-check-selection{font-size:13px;margin:9px 0 5px;overflow-wrap:anywhere}
.va-check-detail{font-size:13px;color:var(--va-muted);margin:0 0 10px;overflow-wrap:anywhere;min-height:20px}
.va-check-card[data-status=failed] .va-check-detail{color:#ffb9b2}
.va-check-card time{font-size:12px;color:var(--va-muted);display:block;margin:0 0 10px}
.va-check-actions{display:flex;gap:8px;margin-top:auto}.va-check-actions button{min-height:44px;padding:8px 12px}
.va-check-note{font-size:12px;color:var(--va-muted);margin:14px 0 0}
.va-checks progress{width:100%;height:6px;margin:0 0 16px;accent-color:var(--va-accent)}
.va-turn-status{color:var(--va-accent);font-size:13px}
.va-current-tool{display:flex;align-items:center;gap:8px;color:var(--va-muted);font-size:13px;margin-top:12px;overflow-wrap:anywhere}
.va-tool-spinner{width:12px;height:12px;flex:none;border:2px solid var(--va-line);border-top-color:var(--va-accent);border-radius:50%}
@media(prefers-reduced-motion:no-preference){.va-tool-spinner{animation:va-tool-spin .9s linear infinite}@keyframes va-tool-spin{to{transform:rotate(360deg)}}}
.va-execution-list{list-style:none;margin:0;padding:0;display:grid;gap:12px}.va-execution-step{border:1px solid var(--va-line);border-radius:8px;padding:12px}.va-execution-step>div{display:flex;justify-content:space-between;gap:12px}.va-execution-step time,.va-execution-step small{color:var(--va-muted);font-size:12px}.va-execution-step pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;font-size:12px}
@media(max-width:620px){.va-checks{padding:14px}.va-check-heading{flex-direction:column;gap:12px}.va-check-heading button{width:100%}.va-check-grid{grid-template-columns:1fr}.va-check-card:last-child{grid-column:auto}}
.va-status{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--va-muted)}
.va-status:before{content:'';width:7px;height:7px;border-radius:50%;background:#778e98}
.va-status[data-running=true]:before{background:var(--va-accent)}
.va-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:16px 0;border-bottom:1px solid var(--va-line)}

.va-empty{padding:48px 16px;text-align:center;color:var(--va-muted)}
.va-empty strong{display:block;font-size:18px;color:inherit;font-weight:550;margin-bottom:8px}
.va-compose{display:flex;gap:10px;width:100%;max-width:1120px;margin:0 auto}.va-compose input{flex:1;min-width:0}
.va-message{display:grid;grid-template-columns:36px minmax(0,1fr);align-items:start;gap:12px;width:fit-content;max-width:min(88%,880px);margin:20px 0;padding:0;white-space:normal;overflow-wrap:anywhere;background:transparent}
.va-message-main{display:flex;flex-direction:column;align-items:flex-start;min-width:0;gap:5px}
.va-avatar{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;overflow:hidden;flex:none;margin-top:3px;background:color-mix(in srgb,var(--va-accent) 15%,var(--va-surface));color:var(--va-accent);font-size:16px;font-weight:600;border:1px solid color-mix(in srgb,var(--va-accent) 22%,transparent)}
.va-avatar img{width:100%;height:100%;object-fit:cover}.va-avatar svg{width:23px;height:23px}.va-avatar[data-kind=user],.va-avatar[data-kind=system]{background:var(--dsw-alias-background-secondary,#203039);color:var(--va-muted);border-color:var(--va-line)}
.va-message-bubble{min-width:0;max-width:100%;padding:12px 16px;border-radius:3px 12px 12px 12px;background:var(--dsw-alias-background-secondary,#1d2b33);white-space:pre-wrap}
.va-typing{display:inline-flex;gap:5px;align-items:center;min-height:26px;padding:0 3px}.va-typing i{width:5px;height:5px;background:var(--va-muted);border-radius:50%}
@media(prefers-reduced-motion:no-preference){.va-typing i{animation:va-typing 1.1s ease-in-out infinite}.va-typing i:nth-child(2){animation-delay:.13s}.va-typing i:nth-child(3){animation-delay:.26s}@keyframes va-typing{0%,65%,100%{opacity:.4;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}.va-spoken,.va-unspoken{transition:color .12s ease-out}}
.va-message-bubble>p{margin:0}.va-message-bubble>small{display:block;margin-top:8px;color:var(--va-muted);font-size:12px}
.va-message-author{display:flex;align-items:baseline;gap:8px;min-width:0;color:var(--va-muted);font-size:12px}.va-message-author strong{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.va-message-source{flex:none;font-size:11px;opacity:.85}
.va-message-time{text-align:center;margin:26px 0 16px;color:var(--va-muted);font-size:12px}.va-message-time:first-child{margin-top:4px}
.va-message[data-notice=true]{margin-inline:auto;max-width:min(90%,740px)}.va-message[data-notice=true] .va-message-bubble{background:transparent;border:1px solid var(--va-line);color:var(--va-muted)}
.va-message[data-role=user]>.va-avatar{grid-column:2;grid-row:1}.va-message[data-role=user]>.va-message-main{grid-column:1;grid-row:1;align-items:flex-end}
.va-message[data-role=user] .va-message-heading{flex-direction:row-reverse}.va-message[data-role=user] .va-message-author{flex-direction:row-reverse}
.va-message[data-role=user] .va-message-bubble{border-radius:12px 3px 12px 12px;background:var(--dsw-alias-background-tertiary,#17383f)}
.va-message[data-role=user]{margin-left:auto;grid-template-columns:minmax(0,1fr) 36px}
.va-preview strong,.va-preview span{display:block}.va-preview p{margin:6px 0 10px}.va-preview a{color:var(--va-accent);font-weight:600}.va-preview-settings{margin:12px 20px 0;flex-shrink:0}.va-help{margin:0 0 18px;padding:10px 12px;border-left:2px solid var(--va-accent)}.va-setup-steps{list-style:none;padding:0;margin:12px 0 0;display:grid;gap:0}.va-setup-steps li{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--va-line)}.va-setup-steps strong{margin:0}.va-setup-steps p{margin:4px 0 0;color:var(--va-muted);font-size:13px}.va-setup-steps button{white-space:nowrap;flex-shrink:0}.va-preview{border:1px solid var(--va-line);border-radius:8px;padding:9px 12px;font-size:12px;color:var(--va-muted)}
@media(max-width:620px){.va-settings{height:calc(92dvh - 72px);min-height:240px}.va-nav{padding:8px}.va-nav button{padding:9px 3px;font-size:12px;white-space:nowrap;min-width:0}.va-pages{padding:14px;scrollbar-gutter:auto}.va-pages fieldset{padding:14px}.va-model-grid,.va-basic-grid,.va-parameter-grid{grid-template-columns:1fr}.va-parameter-wide{grid-column:auto}.va-parameter-grid{padding:0 12px 10px;gap:0}.va-settings-footer{padding:12px 14px;flex-wrap:wrap}.va-settings-footer:has(>div)>p{max-width:100%;flex-basis:100%}.va-settings-footer>div{width:100%}.va-settings-footer>div button{flex:1;padding:9px 7px}.va-credential-line{flex-wrap:wrap}.va-credential-line label{flex-basis:100%}.va-parameter-toolbar .va-identifiers{margin-bottom:0}.va-message{max-width:100%}.va-segments{width:100%}.va-segments button{flex:1}}
@media(prefers-reduced-motion:no-preference){.va-settings button,.va-panel button{transition:background .15s,border-color .15s}.va-group[open] .va-parameter-grid{animation:va-reveal .16s ease-out}@keyframes va-reveal{from{opacity:.5;transform:translateY(-3px)}to{opacity:1;transform:none}}}

.va-panel{height:100%;min-height:0;overflow:hidden;gap:8px!important}
.va-panel button{min-height:44px}.va-panel input{min-height:44px}
.va-live-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-shrink:0}
.va-live-header>div{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.va-live-header strong{font-size:17px}
.va-live-hint{margin:0;color:var(--va-muted);font-size:13px;flex-shrink:0}
.va-host-note{color:var(--va-muted);font-size:11px}
.va-conversation{flex:1;min-height:80px;width:100%;max-width:1120px;margin:0 auto;overflow:auto;overscroll-behavior:contain;padding:8px;scrollbar-gutter:stable;overflow-anchor:none}
.va-actions{flex-shrink:0;padding:0;border:0;gap:8px}.va-compose{flex-shrink:0}
.va-compose input{width:0}.va-message{font-size:15px;line-height:1.7}
.va-waveform{display:flex;align-items:center;gap:12px;flex-shrink:0;color:var(--va-muted);font-size:12px}.va-waveform span{max-width:160px}.va-waveform svg{height:44px;flex:1;max-width:400px;fill:var(--va-accent)}.va-waveform[data-active=false] svg{fill:var(--va-muted)}
.va-latest{align-self:center;font-size:12px;flex-shrink:0}
.va-setup-links{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}.va-nav{overflow-x:auto}.va-nav button{white-space:nowrap;flex-shrink:0}
@media(max-width:620px){.va-live-header>div{gap:5px;flex-direction:column;align-items:flex-start}.va-message{max-width:100%;gap:8px;grid-template-columns:30px minmax(0,1fr)}.va-message[data-role=user]{grid-template-columns:minmax(0,1fr) 30px}.va-avatar{width:30px;height:30px;font-size:14px}.va-avatar svg{width:20px;height:20px}.va-message-bubble{padding:10px 12px}.va-conversation{padding:8px 0}.va-panel{padding:10px!important}}

.va-duplex-status{display:flex;flex-wrap:wrap;gap:6px;flex-shrink:0}.va-duplex-status span{font-size:12px;padding:3px 9px;border:1px solid var(--va-line);border-radius:5px;color:var(--va-muted)}.va-duplex-status span[data-active=true]{color:#baf5e7;border-color:#39796c;background:#193b33}
.va-live-input{max-width:100%;padding:12px 16px;border:1px solid color-mix(in srgb,var(--va-accent) 55%,var(--va-line));border-radius:12px 3px 12px 12px;background:color-mix(in srgb,var(--va-accent) 12%,var(--va-surface));overflow-wrap:anywhere}.va-live-input p{margin:0;white-space:pre-wrap;font-size:15px;line-height:1.7;color:inherit}
.va-expression-card{border:1px solid var(--va-line);border-radius:12px;padding:18px;margin:18px 0;background:var(--dsw-alias-background-secondary,#14242d)}
.va-expression-card h3,.va-preferences h3{margin:0;font-size:16px}.va-cap-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.va-cap-group{margin-top:18px}.va-cap-group h4{font-size:12px;margin:0 0 8px;color:var(--va-muted);font-weight:500}.va-cap-tags{display:flex;flex-wrap:wrap;gap:7px}.va-cap-badge{display:inline-block;padding:4px 9px;border:1px solid var(--va-line);border-radius:6px;font-size:12px;line-height:1.5;color:var(--va-muted)}.va-cap-badge[data-status=available]{color:#baf5e7;background:#193b33;border-color:#39796c}.va-cap-badge[data-status=metadata]{color:#e9d4a1;background:#342d20;border-color:#655638}.va-cap-badge[data-status=unavailable]{border-style:dashed}.va-cap-columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}.va-preferences{margin:22px 0}.va-preferences>.va-basic-grid{margin-top:14px}.va-cap-inventory,.va-advanced-preferences{margin-top:16px;border-top:1px solid var(--va-line);padding-top:14px}.va-cap-table{overflow:auto;margin:12px 0}.va-cap-table table{width:100%;border-collapse:collapse;font-size:13px;text-align:left}.va-cap-table th,.va-cap-table td{padding:11px 9px;border-bottom:1px solid var(--va-line);vertical-align:top}.va-cap-table th{color:var(--va-muted);font-weight:500}.va-cap-table td small{display:block;color:var(--va-muted);margin-top:4px;line-height:1.5}.va-cap-table td:nth-child(2){min-width:95px}.va-cap-table td:last-child{min-width:120px}.va-expression-card>label{min-height:44px;align-items:center}.va-expression-card>.va-note{margin:8px 0 12px;line-height:1.6}
@media(max-width:620px){.va-nav{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));overflow-x:visible}.va-expression-card{padding:14px}.va-cap-columns{grid-template-columns:1fr}.va-cap-heading{align-items:flex-start;flex-direction:column}.va-cap-table{max-width:100%}}

.va-full-page{max-width:none!important;width:100%;margin:0!important;padding:0!important}
.va-message-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:25px;width:100%;white-space:normal}.va-message-details{min-width:32px;min-height:32px;padding:0 6px;border:0;background:transparent;font-size:22px;line-height:1;color:var(--va-muted);flex:none}.va-message-details:hover{color:var(--va-accent)}.va-message-details:focus-visible{outline:2px solid var(--va-accent);outline-offset:2px}
.va-detail-page{display:flex;flex-direction:column;min-height:0;height:100%;width:100%}.va-detail-heading{max-width:none;margin:0;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px 32px;border-bottom:1px solid var(--va-line)}.va-detail-heading h2{margin:0 0 8px;font-size:23px}.va-detail-heading>div:last-child{display:flex;gap:8px}.va-detail-heading button{min-height:42px}
.va-detail-body{overflow:auto;min-height:0;padding:24px 32px;flex:1;overscroll-behavior:contain}.va-detail-text,.va-detail-card{padding:20px 24px;border:1px solid var(--va-line);border-radius:12px;background:var(--dsw-alias-background-secondary,#14242d)}.va-detail-text{margin-bottom:20px}.va-detail-text h3,.va-detail-card h3{margin:0 0 16px;font-size:16px}.va-detail-text p{margin:0;white-space:pre-wrap;max-height:160px;overflow:auto}.va-detail-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:20px;align-items:start}.va-detail-card{min-width:0}.va-detail-card h4{margin:22px 0 10px}.va-detail-pairs{margin:0;display:grid;gap:0}.va-detail-pairs>div{display:grid;grid-template-columns:minmax(100px,30%) minmax(0,1fr);gap:16px;padding:10px 0;border-bottom:1px solid var(--va-line)}.va-detail-pairs dt{color:var(--va-muted)}.va-detail-pairs dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}.va-detail-table{margin-top:16px;overflow:auto}.va-detail-table table{width:100%;border-collapse:collapse;text-align:left}.va-detail-table th,.va-detail-table td{padding:10px 8px;border-bottom:1px solid var(--va-line);vertical-align:top;overflow-wrap:anywhere}.va-detail-table tbody th{font-weight:500;color:var(--va-muted);min-width:100px}.va-detail-table td{white-space:pre-wrap}.va-detail-raw{margin:20px 0;padding:18px 0;border-top:1px solid var(--va-line)}.va-detail-raw pre{max-height:36dvh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:var(--va-surface);border:1px solid var(--va-line);border-radius:8px}.va-detail-page summary{cursor:pointer;min-height:36px}.va-detail-page .va-note{color:var(--va-muted);font-size:13px;line-height:1.6}
@media(max-width:850px){.va-detail-grid{grid-template-columns:1fr}.va-detail-heading{padding:16px;align-items:flex-start}.va-detail-heading h2{font-size:19px}.va-detail-heading>div:last-child{flex-direction:column}.va-detail-body{padding:16px}.va-detail-text,.va-detail-card{padding:16px}.va-detail-pairs>div{grid-template-columns:100px minmax(0,1fr)}.va-message-details{min-height:44px;min-width:44px}}
.va-detail-tts{grid-template-columns:minmax(0,.8fr) minmax(0,2fr)}.va-detail-parameters{margin:16px 0 0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 24px}.va-detail-parameters>div{padding:10px 0;border-bottom:1px solid var(--va-line);min-width:0}.va-detail-parameters dt{color:var(--va-muted);font-size:12px;margin-bottom:5px}.va-detail-parameters dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.va-detail-body{padding:18px 32px}.va-detail-text,.va-detail-card{padding:16px 20px}.va-detail-text{margin-bottom:16px}.va-detail-text h3,.va-detail-card h3{margin-bottom:12px}.va-detail-pairs>div{padding:8px 0}.va-detail-grid{gap:16px}.va-detail-heading{padding:16px 32px}.va-detail-page .va-note{margin:10px 0 0}
@media(max-width:850px){.va-detail-tts{grid-template-columns:1fr}.va-detail-body{padding:16px}.va-detail-heading{padding:16px}.va-detail-parameters{gap:0 16px}}@media(max-width:480px){.va-detail-parameters{grid-template-columns:1fr}}
.va-context-settings{padding:18px 20px;border:1px solid var(--va-line);border-radius:10px}.va-context-settings h3,.va-context-confirm h3{margin:0 0 10px}.va-context-stats{display:flex;gap:24px;flex-wrap:wrap}.va-context-confirm,.va-context-error{padding:16px 20px;border:1px solid var(--va-accent);border-radius:10px;flex-shrink:0}.va-context-confirm p,.va-context-error p{margin:8px 0 14px;line-height:1.6}.va-history-more{display:block;margin:4px auto 16px;font-size:13px}
/* Settings use the available desktop width; controls keep readable type and touch targets. */
.va-conversation-settings{grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start}.va-model-settings{display:grid;gap:18px;min-width:0}.va-identity-settings,.va-connection-settings,.va-recognition-settings{min-width:0;border:1px solid var(--va-line);border-radius:12px;padding:20px;background:var(--va-surface)}.va-identity-settings h3,.va-connection-settings h3{font-size:18px;margin:0 0 18px;font-weight:650}.va-identity-settings textarea{min-height:240px;height:clamp(240px,30dvh,420px);font-size:16px;line-height:1.7}.va-settings .va-pages{font-size:15px}.va-pages label{font-size:15px}.va-pages input:not([type=checkbox]),.va-pages select,.va-pages textarea{min-height:44px;font-size:15px}.va-pages p{font-size:14px}.va-pages small{font-size:13px}.va-pages legend{font-size:18px}.va-pages .va-service{padding:0;border:0}.va-service>legend{padding:0;margin-bottom:16px}.va-speech-layout{display:grid;grid-template-columns:minmax(340px,.85fr) minmax(0,1.4fr);gap:20px;align-items:start}.va-expression-settings{min-width:0}.va-expression-settings>.va-expression-card:first-child{margin-top:0}.va-expression-card{padding:18px 20px;margin:0 0 16px}.va-cap-group{margin-top:12px}.va-cap-badge{font-size:13px;padding:4px 8px}.va-cap-heading{align-items:flex-start;margin-bottom:10px;flex-wrap:wrap}.va-cap-heading h3{font-size:17px}.va-cap-io{margin-top:14px;border-top:1px solid var(--va-line);padding-top:10px}.va-cap-io>summary{font-size:14px;color:var(--va-muted);min-height:32px}.va-parameter-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start}.va-parameter-groups>.va-group{margin:0}.va-parameter-grid{grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:0 18px}.va-group>summary{min-height:52px;font-size:15px}.va-recognition-settings .va-parameter-toolbar{margin-bottom:16px}.va-connection-settings .va-basic-grid{align-items:start}.va-connection-settings .va-basic-grid>button{align-self:end;margin-bottom:12px}.va-connection-settings .va-credential{margin:16px 0!important;padding:14px 16px}.va-connection-settings .va-model-grid>p{font-size:13px;line-height:1.5;margin:0 0 10px}.va-connection-settings .va-advanced{margin-top:14px}.va-connection-settings .va-voice-picker{padding-top:16px;margin-top:8px}.va-voice-picker>div:first-child{margin-bottom:12px}.va-voice-picker>button{margin:4px 8px 0 0}.va-voice-actions{margin-top:14px}.va-voice-actions a{font-size:13px}.va-preferences{margin:18px 0;padding:18px 20px;border:1px solid var(--va-line);border-radius:12px}.va-preferences .va-parameter{padding:10px 0}.va-context-settings{padding:16px 20px}.va-context-settings h3{font-size:16px}.va-context-settings p{margin:8px 0;font-size:13px}.va-context-stats{font-size:14px;gap:12px 20px}.va-settings-footer{padding:12px 24px}.va-settings-footer button{min-height:44px}.va-check-grid{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}.va-check-card:last-child{grid-column:auto}
@media(max-width:1100px){.va-conversation-settings,.va-speech-layout{grid-template-columns:minmax(0,1fr)}.va-identity-settings textarea{height:240px}.va-parameter-groups{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:620px){.va-parameter-groups{grid-template-columns:minmax(0,1fr)}.va-identity-settings,.va-connection-settings,.va-recognition-settings{padding:16px}.va-model-settings{gap:16px}.va-preferences{padding:16px}.va-identity-settings textarea{min-height:200px;height:240px}.va-pages input:not([type=checkbox]),.va-pages select,.va-pages textarea{font-size:16px}}

.va-voice-settings{min-width:0;padding:20px;border:1px solid var(--va-line);border-radius:12px;background:var(--va-surface)}.va-voice-settings h3{font-size:18px;margin:0 0 16px}.va-voice-settings .va-voice-picker{border-top:0;margin-top:0;padding-top:0}.va-voice-picker>div:first-child label{display:inline-flex;flex-direction:row;align-items:center;gap:8px;white-space:nowrap;margin:0}.va-voice-picker>div:first-child{min-height:28px}.va-voice-picker>button{margin:4px 8px 0 0}.va-connection-tools{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px;align-items:start}.va-connection-tools:has(details[open]){grid-template-columns:1fr}.va-connection-tools .va-credential,.va-connection-tools .va-advanced{margin:0!important;padding:12px 14px;border:1px solid var(--va-line);border-radius:8px}.va-connection-tools summary{min-height:24px}.va-fixed-resource{font-size:13px;color:var(--va-muted);grid-column:1/-1;padding:0 0 8px}.va-tts-layout .va-model-grid>details{grid-column:1/-1;padding-bottom:0}.va-full-page .va-service>legend{display:none}.va-tts-layout .va-connection-settings h3{margin-bottom:16px}.va-settings .va-pages{font-size:16px}.va-pages label,.va-pages input:not([type=checkbox]),.va-pages select,.va-pages textarea{font-size:16px}.va-pages p{font-size:14px}

.va-voice-filters{margin-top:14px;padding-top:10px;border-top:1px solid var(--va-line)}.va-voice-filters>summary{font-size:14px;min-height:36px;color:var(--va-muted)}.va-voice-filters[open]>summary{margin-bottom:10px}.va-voice-filters>div:first-of-type{margin-bottom:12px}.va-voice-filters>div:first-of-type label{display:inline-flex;align-items:center;gap:8px;margin:0;white-space:nowrap}.va-voice-filters>button{margin:6px 8px 0 0}.va-preferences{margin:0 0 16px;padding:12px 20px}.va-preferences>summary{min-height:32px;font-size:15px;font-weight:550;cursor:pointer}.va-preferences[open]>summary{padding-bottom:10px;border-bottom:1px solid var(--va-line)}
.va-expression-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.va-expression-toolbar>label{min-height:44px;margin:0!important;flex:1}.va-expression-toolbar>button{font-size:13px;white-space:nowrap}.va-expression-settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.va-expression-settings>.va-expression-card,.va-expression-settings>.va-preferences{grid-column:1/-1;margin:0}.va-expression-settings>.va-cap-inventory,.va-expression-settings>.va-advanced-preferences{min-width:0;margin:0;padding-top:12px}.va-expression-settings>details[open]{grid-column:1/-1}.va-expression-settings>.va-cap-inventory>summary,.va-expression-settings>.va-advanced-preferences>summary{font-size:13px;min-height:36px}
@media(max-width:620px){.va-expression-settings{grid-template-columns:1fr}.va-expression-toolbar>label{flex-basis:100%}}
/* TTS has two equally weighted tasks; only the preview is a primary action. */
.va-tts-layout,.va-asr-layout{grid-template-columns:repeat(2,minmax(0,1fr));align-items:stretch;gap:20px}
.va-asr-layout .va-parameter-toolbar>label:first-child{font-size:18px;font-weight:650}
.va-tts-layout>.va-tts-selection,.va-tts-layout>.va-tts-capabilities{margin:0;border:1px solid var(--va-line);border-radius:12px;background:var(--va-surface);padding:20px;min-width:0}
.va-tts-card-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:28px;margin-bottom:16px}
.va-tts-layout .va-tts-card-heading h3{font-size:18px;font-weight:650;margin:0}
.va-expression-state{font-size:13px;color:var(--va-muted)}
.va-tts-selection .va-voice-settings{padding:0;border:0;background:transparent;border-radius:0;margin-top:12px}
.va-tts-selection .va-voice-picker{border:0;padding:0;margin:0}.va-tts-selection .va-voice-picker>label{margin-bottom:4px!important}
.va-tts-selection .va-voice-actions{display:flex;align-items:center;gap:16px;margin-top:12px}
.va-tts-selection .va-voice-actions button{min-height:44px;font-size:15px}.va-tts-selection .va-voice-actions a{font-size:13px}
.va-tts-selection .va-connection-tools{margin-top:16px;gap:12px}.va-tts-selection .va-connection-tools summary{font-size:13px;line-height:22px}
.va-tts-selection .va-model-grid>details{padding-top:0}.va-tts-selection .va-model-grid>details>summary{font-size:13px;min-height:32px;color:var(--va-muted)}
.va-tts-capabilities .va-expression-control{padding:0 0 16px;margin:0 0 16px;border-bottom:1px solid var(--va-line)}
.va-tts-capabilities .va-expression-toolbar{gap:8px;flex-wrap:nowrap}.va-tts-capabilities .va-expression-toolbar>label{font-size:15px;line-height:1.5;gap:8px}
.va-tts-capabilities .va-expression-toolbar>button{min-height:40px;font-size:13px;padding:8px 12px;background:transparent}
.va-tts-capabilities .va-expression-control p{font-size:13px;margin:8px 0 0;line-height:1.65}
.va-tts-capabilities .va-cap-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.va-tts-capabilities .va-cap-heading h3{font-size:15px;font-weight:600;margin:0}.va-tts-capabilities .va-cap-heading small{font-size:12px;color:var(--va-muted)}
.va-cap-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.va-cap-item{min-width:0}
.va-settings .va-cap-trigger{width:100%;min-height:68px;height:100%;display:flex;justify-content:space-between;align-items:center;gap:6px;padding:10px 12px;border:1px solid var(--va-line);border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.va-cap-trigger>span:first-child{display:flex;flex-direction:column;gap:4px;min-width:0}.va-cap-trigger strong{font-size:14px;font-weight:550;line-height:1.4}.va-cap-trigger small{font-size:12px;line-height:1.4;color:var(--va-muted)}
.va-settings .va-cap-trigger[data-status=available]{border-color:#386056;background:#142f2a}.va-cap-trigger[data-status=available] small{color:#a2ddcc}
.va-settings .va-cap-trigger:hover{border-color:var(--va-accent);background:#1c343b}.va-cap-trigger[data-status=unavailable]{color:var(--va-muted)}
.va-cap-question{display:inline-flex;justify-content:center;align-items:center;flex:none;width:18px;height:18px;border:1px solid currentColor;border-radius:50%;font-size:12px;line-height:1;color:var(--va-muted)}
.va-tts-capabilities .va-cap-io{margin:16px 0 0;padding-top:8px}.va-tts-capabilities .va-cap-io>summary{min-height:32px;font-size:13px}
.va-tts-layout>.va-tts-preferences{grid-column:1/-1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.va-tts-preferences>.va-preferences,.va-tts-preferences>.va-cap-inventory,.va-tts-preferences>.va-advanced-preferences{grid-column:auto;padding:0;margin:0;border:1px solid var(--va-line);border-radius:8px;background:var(--va-surface)}
.va-tts-preferences>details>summary{display:flex;align-items:center;gap:10px;padding:14px 16px;min-height:52px!important;font-size:14px!important;font-weight:500;list-style:none;cursor:pointer;color:inherit}
.va-tts-preferences>details>summary::after{content:'+';font-size:18px;color:var(--va-muted);margin-left:auto}.va-tts-preferences>details[open]>summary::after{content:'−'}
.va-tts-preferences>details[open]{grid-column:1/-1;padding:0 16px 16px}.va-tts-preferences>details[open]>summary{margin:0 -16px 12px;border-bottom:1px solid var(--va-line)}
.va-cap-dialog{padding:0;border:1px solid var(--va-line);border-radius:14px;background:var(--va-surface);color:inherit;width:min(580px,calc(100vw - 32px));max-height:calc(100dvh - 48px);overflow:auto;box-shadow:0 20px 80px #0008;font:inherit}
.va-cap-dialog::backdrop{background:#02090dbb}.va-cap-dialog-content{padding:24px}.va-cap-dialog header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:20px}
.va-cap-dialog header p{font-size:12px;margin:0 0 4px}.va-cap-dialog header h3{font-size:22px;margin:0}.va-cap-dialog header button{min-height:40px;padding:8px 14px;font-size:14px;background:transparent}
.va-cap-dialog .va-cap-current{padding:10px 12px;border:1px solid var(--va-line);border-radius:7px;font-size:14px;color:inherit;margin:0 0 8px}.va-cap-current[data-status=available]{border-color:#386056;background:#142f2a}
.va-cap-dialog .va-cap-selection{font-size:12px;line-height:1.6;margin:0 0 20px}.va-cap-dialog section{margin:0 0 18px}.va-cap-dialog h4{font-size:14px;margin:0 0 6px;font-weight:600}.va-cap-dialog section p{font-size:15px;line-height:1.75;margin:0;color:inherit}
.va-cap-dialog details{border-top:1px solid var(--va-line);padding-top:8px}.va-cap-dialog details summary{font-size:13px;min-height:36px}.va-cap-dialog code{font-size:12px;overflow-wrap:anywhere;white-space:pre-wrap;display:block;padding:8px 0}
.va-cap-dialog footer{display:flex;flex-direction:column;gap:6px;padding-top:16px;margin-top:8px;border-top:1px solid var(--va-line)}.va-cap-dialog footer a{font-size:13px}.va-cap-dialog footer small{font-size:12px;color:var(--va-muted)}
@media(min-width:1101px) and (max-height:800px){.va-tts-layout{gap:16px}.va-tts-layout>.va-tts-selection,.va-tts-layout>.va-tts-capabilities{padding:16px}.va-tts-card-heading{margin-bottom:12px}}
@media(max-width:1100px){.va-tts-layout,.va-asr-layout{grid-template-columns:1fr;grid-template-areas:none}.va-tts-layout>.va-tts-preferences{grid-template-columns:1fr}.va-tts-capabilities .va-expression-toolbar>label{flex:1}}
@media(max-width:620px){.va-tts-layout>.va-tts-selection,.va-tts-layout>.va-tts-capabilities{padding:16px}.va-cap-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.va-tts-card-heading{flex-wrap:wrap}.va-tts-capabilities .va-expression-toolbar{flex-wrap:wrap}.va-tts-capabilities .va-expression-toolbar>label{flex-basis:100%}.va-cap-dialog-content{padding:20px}.va-cap-dialog{max-height:calc(100dvh - 32px)}}

.va-timed-message p{margin:0;white-space:pre-wrap}.va-spoken{color:#a7f1d9}.va-unspoken{color:var(--va-muted)}.va-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.va-asr-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.va-asr-heading h3{margin:0}.va-asr-capabilities h4{margin:16px 0 10px;font-size:14px;color:var(--va-muted)}.va-asr-capabilities .va-cap-grid{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.va-asr-feature{display:flex;align-items:center;gap:7px;min-width:0}.va-asr-feature>input{flex:none;width:18px;height:18px;accent-color:var(--va-accent)}.va-asr-feature>.va-cap-trigger{flex:1;min-width:0}.va-asr-capabilities .va-cap-trigger{padding:9px;min-height:58px}.va-asr-capabilities .va-cap-trigger strong{font-size:14px}.va-asr-system,.va-asr-preferences{border-top:1px solid var(--va-line);margin-top:16px;padding-top:10px}.va-asr-capabilities .va-note{margin:12px 0;font-size:13px}
`;
