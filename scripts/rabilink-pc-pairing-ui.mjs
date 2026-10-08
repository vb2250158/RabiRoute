export function buildPcOnboardingPrompt({ relayUrl, appId, appName, ticket, expiresAt, files }) {
  const relay = new URL(relayUrl);
  if (!['https:', 'http:'].includes(relay.protocol) || relay.username || relay.password || relay.search || relay.hash || relay.pathname !== '/') throw new Error('服务器地址无效。');
  if (relay.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(relay.hostname)) throw new Error('公网接入必须使用 HTTPS。');
  if (!/^rpt_[A-Za-z0-9_-]{43}$/.test(ticket || '') || !appId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('接入码无效或已过期，请重新复制。');
  const downloads = ['rabilink-pair-pc.mjs', 'rabilink-pc-pairing.mjs'].map(name => {
    const file = files?.find(item => item.name === name);
    if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 1) throw new Error('缺少接入程序校验信息。');
    return `${relay.origin}/api/rabilink/pc-pairings/client/${name}\nSHA-256: ${file.sha256}\nSize: ${file.size}`;
  }).join('\n\n');
  return `请把当前电脑上的独立 RabiPC 接入以下 RabiLink 应用，完成环境检查、安装、私有配置、启动和真实连接验证。

服务器: ${relay.origin}
目标应用 ID: ${appId}
应用名称: ${JSON.stringify(appName)}
一次性接入码: ${ticket}
有效期至: ${new Date(expiresAt).toISOString()}（30 分钟内有效，成功兑换后立即失效）
本提示词已含完整接入授权，无需用户手填应用 token 或再次批准。同一接入码只授权一台新电脑；不要用它接入其他设备。

1. 检查当前环境是否能执行命令、保存私有文件并运行服务，以及 Node.js 20+。有独立 RabiRoute 时沿用其 Host、运行根目录和身份；没有时从 https://github.com/vb2250158/RabiRoute 的当前公开文档完成本环境的安装与 Host 初始化。保留原业务配置，不复制其他电脑的 GUID，不另起重复 Manager。给当前实例设置可识别的名称。
2. 从下面两个固定同源地址下载接入程序到当前用户的私有安装目录，禁止跨源重定向。逐个核对本提示词给出的 SHA-256 与字节数，全部一致后才能运行；服务器响应头摘要不能代替这里固定的摘要。校验失败立即停止。下载包属于本服务器的版本，不能用云端旧源码替代。

${downloads}

3. 运行下载目录中的 node rabilink-pair-pc.mjs --relay ${relay.origin} --state-root <当前实例的绝对运行根目录> --name <实例名称> --ticket-stdin。把上面的接入码通过子进程标准输入传入；不放到命令参数、历史、截图或日志中。运行根目录下面必须已有独立 data/Config.json。此提示词明确授权该程序在此实例私有 data/pc-pairing-request.json 暂存接入码与恢复信息，并在 data/Config.json 保存专属连接凭据。该目录须位于仓库外或经 Git 确认忽略且未跟踪。程序保存原配置备份并回读，保留其他字段，成功后清除请求记录中的接入码。
4. 用原 Host 启动或重启实例，使连接生效。检查服务器的设备列表确有本机身份，再完成一次同应用内设备发现或授权只读访问。不要把安装成功、兑换成功或健康通过当成已上线。网络结果不确定时按相同请求记录恢复，不重复生成身份或兑换到另一设备。
5. 回报实例名称、身份、是否在线、实际只读验证结果，以及服务能否在当前任务结束后持续运行。临时云端环境不能保证常驻时明确说明。现有已连接实例不重复接入；接入码过期或已经被其他请求使用时才让用户重新复制提示词。凭据不回显。

接入码仅用于本次私密安装，不写入公开仓库、群聊或无关文件。长期凭据由程序在本机生成，服务器只接收摘要。`;
}
export function pcPairingPanelHtml() {
  return `<section id="pcPairingCard" class="card hidden"><div class="title">接入提示词</div><p class="note">复制后粘贴到目标电脑的私密 Agent 任务。接入码三十分钟有效，只能成功使用一次。</p><textarea id="pcOnboardingPromptOutput" aria-label="接入提示词" readonly rows="12"></textarea></section>`;
}
export function pcPairingBrowserScript() {
  return `const buildPcOnboardingPrompt = ${buildPcOnboardingPrompt.toString()};` + String.raw`
    let pcEnrollment = null;
    let issuingPcEnrollment = false;
    function pcRevokeButton(app, credential) {
      const revoke = document.createElement('button'); revoke.type = 'button'; revoke.textContent = '断开连接';
      revoke.addEventListener('click', async () => {
        if (!window.confirm('断开 ' + credential.deviceName + ' 后，需要重新接入才能连接。继续？')) return;
        revoke.disabled = true;
        try {
          await request(apiBase + '/apps/' + encodeURIComponent(app.id) + '/pc-credentials/' + encodeURIComponent(credential.id),
            { method: 'DELETE', headers: { ...headers(true), 'x-rabilink-pairing-write': '1' }, body: '{}' });
          await load();
        } catch (error) { flash('alert', error.message); revoke.disabled = false; }
      });
      return revoke;
    }
    function syncPcPairingUi() {
      const app = state.apps.find(item => item.id === state.selectedAppId);
      const available = Boolean(state.account && app && !state.creatingApp && !integrationMode);
      if (pcEnrollment && (pcEnrollment.accountId !== state.account?.id || pcEnrollment.appId !== app?.id)) {
        pcEnrollment = null; el('pcOnboardingPromptOutput').value = ''; el('pcPairingCard').classList.add('hidden');
      }
      el('addDeviceButton').classList.toggle('hidden', !available);
      el('addDeviceButton').disabled = issuingPcEnrollment || app?.enabled === false;
      const credentials = el('pcPairingCredentials'); credentials.replaceChildren();
      for (const credential of app?.pcCredentials || []) {
        if (!credential.enabled || state.workers.some(worker => worker.appId === app.id && (worker.id === credential.deviceId || worker.guid === credential.deviceGuid))) continue;
        const row = document.createElement('div'); row.className = 'worker';
        const label = document.createElement('span'); label.textContent = credential.deviceName + ' · 等待上线';
        row.append(label, pcRevokeButton(app, credential)); credentials.append(row);
      }
    }
    async function copyPcInstallPrompt() {
      if (issuingPcEnrollment || !state.account) return;
      const app = state.apps.find(item => item.id === state.selectedAppId);
      if (!app || app.enabled === false) return;
      const accountId = state.account.id;
      issuingPcEnrollment = true; syncPcPairingUi();
      try {
        if (!pcEnrollment || (pcEnrollment.expiresAt > 0 && pcEnrollment.expiresAt <= Date.now())) {
          const bytes = crypto.getRandomValues(new Uint8Array(32));
          const ticket = 'rpt_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket));
          const ticketHash = Array.from(new Uint8Array(hashBytes), byte => byte.toString(16).padStart(2, '0')).join('');
          pcEnrollment = { accountId, appId: app.id, id: crypto.randomUUID(), ticket, ticketHash, expiresAt: 0 };
        }
        const enrollment = pcEnrollment;
        const response = await request(apiBase + '/apps/' + encodeURIComponent(app.id) + '/pc-pairing-tickets', {
          method: 'POST', headers: { ...headers(true), 'x-rabilink-pairing-write': '1' },
          body: JSON.stringify({ id: enrollment.id, ticketHash: enrollment.ticketHash }) });
        if (state.account?.id !== accountId || state.selectedAppId !== app.id || pcEnrollment !== enrollment) return;
        if (response.data.id !== enrollment.id || response.data.appId !== app.id) throw new Error('接入回执身份不一致，请刷新后核对。');
        if (response.data.consumed) { pcEnrollment = null; throw new Error('此接入码已被使用。再次点击可复制新的接入提示词。'); }
        enrollment.expiresAt = response.data.expiresAt;
        const prompt = buildPcOnboardingPrompt({ relayUrl: window.location.origin, appId: app.id, appName: app.name,
          ticket: enrollment.ticket, expiresAt: enrollment.expiresAt, files: response.data.files });
        try {
          await copyText(prompt);
          pcEnrollment = null;
          el('pcOnboardingPromptOutput').value = ''; el('pcPairingCard').classList.add('hidden');
          flash('notice', '接入提示词已复制，三十分钟内有效。粘贴给目标电脑上的 Agent，它会自动完成接入。');
        } catch {
          el('pcOnboardingPromptOutput').value = prompt; el('pcPairingCard').classList.remove('hidden');
          el('pcOnboardingPromptOutput').focus(); el('pcOnboardingPromptOutput').select();
          flash('notice', '浏览器未能复制。已选中完整提示词，请复制后粘贴到目标电脑的私密任务。');
        }
      } catch (error) { flash('alert', error.message); }
      finally { issuingPcEnrollment = false; syncPcPairingUi(); }
    }
    el('addDeviceButton').addEventListener('click', copyPcInstallPrompt);
  `;
}
