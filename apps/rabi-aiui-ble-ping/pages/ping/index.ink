<script def>
{ "navigationBarTitleText": "Rabi BLE 测试", "description": "前台 BLE ping/pong 诊断，无参数。", "schema": { "data": { "type": "object", "properties": {}, "required": [], "additionalProperties": false } } }
</script>

<script setup>
import wx from 'wx';
const SERVICE = '78c20001-48a3-4b18-a401-819ec0200001';
const CHARACTERISTIC = '78c20002-48a3-4b18-a401-819ec0200001';
const VERIFIED_PHONE = 'rabi.ble.ping.verified-phone.v1';
function errorText(error) {
  return String(error && error.name || 'Error') + ': ' + String(error && error.message || error);
}

export default {
  data: { status: '准备自动扫描手机测试服务', stage: '未开始', result: '尚无结果', reason: '页面就绪', input: '每次打开仅自动测试一次', busy: false },
  visible: true,
  unloaded: false,
  ready: false,
  autoAttempted: false,
  scan: null,
  scanListener: null,
  scanDeadline: null,
  cancelDiscovery: null,
  generation: 0,
  device: null,
  deadline: null,
  async rememberedTarget(run) {
    this.setStage('G1 getDevices 调用');
    let devices;
    try {
      const pending = navigator.bluetooth.getDevices();
      this.setStage('G2 等待 getDevices');
      devices = await pending;
      if (!Array.isArray(devices)) throw new TypeError('getDevices 未返回数组');
    } catch (error) {
      this.setData({ reason: '记住设备不可用：' + errorText(error) + '；改用服务过滤扫描' });
      return null;
    }
    if (run !== this.generation) return null;
    this.setStage('G3 核对已验证手机');
    let saved;
    try { saved = wx.getStorageSync(VERIFIED_PHONE); }
    catch (error) { this.setData({ reason: '读取测试记录失败：' + errorText(error) }); }
    const matches = saved && saved.service === SERVICE && typeof saved.id === 'string'
      ? devices.filter(device => device && device.id === saved.id) : [];
    this.setData({ reason: '运行时记住 ' + devices.length + ' 个设备；已验证目标 ' + matches.length + ' 个（不是系统配对列表）' });
    return matches.length === 1 ? matches[0] : null;
  },
  autoStart() {
    if (this.ready && this.visible && !this.autoAttempted && !this.unloaded) {
      this.autoAttempted = true;
      this.test();
    }
  },
  async discover(run) {
    this.setStage('S1 scanDevices 调用');
    const pending = navigator.bluetooth.scanDevices({ filters: [{ services: [SERVICE] }] });
    this.setStage('S2 等待 scanDevices 返回');
    const scan = await pending;
    if (run !== this.generation) { scan.stop(); throw new Error('扫描已取消'); }
    this.scan = scan;
    return new Promise((resolve, reject) => {
      const devices = new Map();
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        this.releaseScan();
        reject(error);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        this.releaseScan();
        if (devices.size === 1) resolve(devices.values().next().value);
        else reject(new Error(devices.size ? '发现多个测试手机；仅保留目标手机广播后重试' : '未发现手机测试服务；确认手机诊断页在前台'));
      };
      this.cancelDiscovery = reject;
      this.scanListener = event => {
        if (settled || run !== this.generation) return;
        try {
          this.setStage('S5 解析扫描回调');
          const device = event.device;
          if (!device || typeof device.id !== 'string' || !device.id) throw new TypeError('扫描回调缺少 device.id');
          devices.set(device.id, device);
        } catch (error) { fail(error); }
      };
      try {
        this.setStage('S3 注册扫描监听');
        scan.onDeviceFound(this.scanListener);
        if (!settled) {
          this.setStage('S4 等待扫描回调（4 秒）');
          this.scanDeadline = setTimeout(finish, 4000);
        }
      } catch (error) { fail(error); }
    });
  },
  releaseScan() {
    if (this.scanDeadline != null) clearTimeout(this.scanDeadline);
    this.scanDeadline = null;
    if (this.scan) {
      try { if (this.scanListener) this.scan.offDeviceFound(this.scanListener); }
      catch (error) { console.warn('BLE listener cleanup ' + errorText(error)); }
      try { this.scan.stop(); }
      catch (error) { console.warn('BLE scan cleanup ' + errorText(error)); }
    }
    this.scan = null;
    this.scanListener = null;
    this.cancelDiscovery = null;
  },
  setStage(stage) { this.setData({ stage, status: stage }); console.info('BLE stage', stage); },
  async test() {
    if (this.data.busy || !this.visible || this.unloaded) return;
    const run = ++this.generation;
    this.autoAttempted = true;
    this.setData({ busy: true, result: '进行中', reason: '本次开始' });
    this.setStage('检查 BLE 能力');
    this.deadline = setTimeout(() => {
      if (run === this.generation) this.cancelRun('超时：连接或读写超过 30 秒');
    }, 30000);
    try {
      if (!navigator.bluetooth || !(await navigator.bluetooth.getAvailability())) throw new Error('BLE 不可用');
      if (run !== this.generation) return;
      const remembered = await this.rememberedTarget(run);
      if (run !== this.generation) return;
      const device = remembered || await this.discover(run);
      if (run !== this.generation) return;
      this.device = device;
      this.setStage('连接手机 GATT');
      const server = await device.gatt.connect();
      if (run !== this.generation) { await device.gatt.disconnect(); return; }
      this.setStage('查找服务');
      const service = await server.getPrimaryService(SERVICE);
      if (run !== this.generation) return;
      const characteristic = await service.getCharacteristic(CHARACTERISTIC);
      if (run !== this.generation) return;
      const bytes = new Uint8Array(4);
      crypto.getRandomValues(bytes);
      const nonce = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
      const ping = 'ping:' + nonce;
      this.setStage('发送 ' + ping);
      await characteristic.writeValueWithResponse(new Uint8Array(Array.from(ping, value => value.charCodeAt(0))));
      if (run !== this.generation) return;
      this.setStage('读取 pong');
      const reply = await characteristic.readValue();
      if (run !== this.generation) return;
      if (!Array.isArray(reply) || reply.length !== 13 || reply.some(value => !Number.isInteger(value) || value < 0 || value > 127)) {
        throw new Error('返回值不是预期的 13 字节 ASCII 数组');
      }
      const pong = String.fromCharCode(...reply);
      if (pong !== 'pong:' + nonce) throw new Error('pong nonce 不匹配');
      this.setData({ status: '通过：收到 ' + pong, result: '通过：' + pong });
      try { wx.setStorageSync(VERIFIED_PHONE, { id: device.id, service: SERVICE }); }
      catch (error) { this.setData({ reason: '往返成功，但未保存目标：' + errorText(error) }); }
    } catch (error) {
      if (run === this.generation) this.setData({ status: '未通过：' + errorText(error), result: '失败：' + errorText(error), reason: '停止阶段：' + this.data.stage + '；无自动重试' });
    } finally {
      if (run === this.generation) {
        if (this.deadline != null) clearTimeout(this.deadline);
        this.deadline = null;
        const device = this.device;
        this.device = null;
        try { if (device) await device.gatt.disconnect(); }
        catch (error) { if (run === this.generation) this.setData({ reason: '断开失败：' + String(error.message || error) }); }
        if (run === this.generation) this.setData({ busy: false });
      }
    }
  },
  stop() { this.setData({ input: '用户点击停止' }); this.cancelRun('用户停止'); },
  cancelRun(reason, render = true) {
    const wasBusy = this.data.busy;
    const rejectDiscovery = this.cancelDiscovery;
    this.releaseScan();
    if (rejectDiscovery) rejectDiscovery(new Error(reason));
    this.generation++;
    if (this.deadline != null) clearTimeout(this.deadline);
    this.deadline = null;
    const device = this.device;
    this.device = null;
    console.info('BLE lifecycle', reason, 'lastStage', this.data.stage, 'lastResult', this.data.result);
    if (render) this.setData({ busy: false, reason, ...(wasBusy ? { result: '中断：' + reason } : {}) });
    if (device) device.gatt.disconnect().catch(error => console.warn('BLE disconnect failed', String(error.message || error)));
  },
  onShow() {
    this.visible = true;
    if (!this.data.busy && this.autoAttempted) this.setData({ reason: this.data.reason + '；已显示，可手动重试' });
    this.autoStart();
  },
  onReady() { this.ready = true; this.autoStart(); },
  onHide() {
    this.visible = false;
    this.cancelRun(this.data.busy && this.data.stage.startsWith('S')
      ? '扫描期间页面隐藏；返回后手动重试' : '页面隐藏');
  },
  onUnload() { this.visible = false; this.unloaded = true; this.cancelRun('页面卸载', false); },
  onKeyUp(event) {
    this.setData({ input: '按键：' + String(event.code) });
    if (event.code === 'Enter') {
      event.preventDefault();
      if (!this.data.busy) this.test();
    }
  },
};
</script>

<page>
  <view class="surface">
    <text class="title">BLE v0.3</text>
    <text class="status">{{status}}</text>
    <button bindtap="test" disabled="{{busy}}">重试自动测试</button>
    <button wx:if="{{busy}}" bindtap="stop">停止当前测试</button>
    <text class="note">阶段：{{stage}} / {{result}}</text>
    <text class="note">{{reason}}</text>
    <text class="note">{{input}}</text>
  </view>
</page>

<style>
.surface { width: 100%; min-height: 100%; padding: 12px; display: flex; flex-direction: column; gap: 8px; color: #00ff88; background-color: #000000; }
.title { font-size: 22px; }
.status { font-size: 18px; }
.note { font-size: 14px; }
button { min-height: 40px; color: #00ff88; background-color: #102018; border: 1px solid #00ff88; }
button:focus { background-color: #285038; border: 2px solid #00ff88; }
</style>
