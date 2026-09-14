package com.rabi.link.modules.rokid;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.IBinder;
import android.os.RemoteException;

import com.rokid.ai.basic.AudioAiConfig;
import com.rokid.ai.basic.aidl.IRokidAudioAiListener;
import com.rokid.ai.basic.aidl.IRokidAudioAiService;
import com.rokid.ai.basic.aidl.ServerConfig;
import com.rokid.ai.basic.socket.base.ClientSocketManager;
import com.rokid.ai.basic.socket.business.record.RecordClientManager;
import com.rokid.ai.basic.util.FileUtil;
import com.rokid.ai.basic.util.Logger;

final class RokidAiSdkVoiceBridge {
    static final String DEFAULT_WORK_DIR = "workdir_asr_cn";
    static final String DEFAULT_CONFIG_FILE = "lothal_single.ini";

    interface Listener {
        void onAiSdkLog(String line);

        void onAiSdkAsrText(String text, boolean finalResult, boolean local);

        void onAiSdkTtsRequested(String text);

        void onAiSdkError(String kind, String message);

        void onAiSdkState(String state, String detail);
    }

    static final class Credentials {
        final String key;
        final String secret;
        final String deviceTypeId;
        final String deviceId;
        final String seed;
        final String workDir;
        final String configFile;

        Credentials(
                String key,
                String secret,
                String deviceTypeId,
                String deviceId,
                String seed,
                String workDir,
                String configFile
        ) {
            this.key = clean(key);
            this.secret = clean(secret);
            this.deviceTypeId = clean(deviceTypeId);
            this.deviceId = clean(deviceId);
            this.seed = clean(seed);
            this.workDir = cleanOrDefault(workDir, DEFAULT_WORK_DIR);
            this.configFile = cleanOrDefault(configFile, DEFAULT_CONFIG_FILE);
        }

        boolean isComplete() {
            return !key.isEmpty()
                    && !secret.isEmpty()
                    && !deviceTypeId.isEmpty()
                    && !deviceId.isEmpty()
                    && !seed.isEmpty();
        }

        String missingFields() {
            StringBuilder builder = new StringBuilder();
            appendMissing(builder, "key", key);
            appendMissing(builder, "secret", secret);
            appendMissing(builder, "deviceTypeId", deviceTypeId);
            appendMissing(builder, "deviceId", deviceId);
            appendMissing(builder, "seed", seed);
            return builder.length() == 0 ? "<none>" : builder.toString();
        }

        String summary() {
            return "configured=" + isComplete()
                    + ";missing=" + missingFields()
                    + ";key=" + mask(key)
                    + ";secret=" + mask(secret)
                    + ";deviceTypeId=" + mask(deviceTypeId)
                    + ";deviceId=" + mask(deviceId)
                    + ";seed=" + mask(seed)
                    + ";workDir=" + workDir
                    + ";configFile=" + configFile;
        }

        private static void appendMissing(StringBuilder builder, String name, String value) {
            if (value != null && !value.trim().isEmpty()) {
                return;
            }
            if (builder.length() > 0) {
                builder.append(',');
            }
            builder.append(name);
        }
    }

    static final class ProbeResult {
        final boolean assetsReady;
        final boolean nativeAbiReady;
        final boolean recordAudioPermission;
        final boolean credentialsReady;
        final boolean serviceConnected;
        final boolean recording;
        final String summary;

        ProbeResult(
                boolean assetsReady,
                boolean nativeAbiReady,
                boolean recordAudioPermission,
                boolean credentialsReady,
                boolean serviceConnected,
                boolean recording,
                String summary
        ) {
            this.assetsReady = assetsReady;
            this.nativeAbiReady = nativeAbiReady;
            this.recordAudioPermission = recordAudioPermission;
            this.credentialsReady = credentialsReady;
            this.serviceConnected = serviceConnected;
            this.recording = recording;
            this.summary = summary;
        }

        boolean readyToStart() {
            return assetsReady && nativeAbiReady && recordAudioPermission && credentialsReady;
        }
    }

    private static final String TAG = "RokidAiSdkVoiceBridge";
    private static final int FREQUENCY = 16000;
    private static final int CHANNEL = AudioFormat.CHANNEL_IN_MONO;
    private static final int ENCODING_BIT = AudioFormat.ENCODING_PCM_16BIT;

    private final Context appContext;
    private final Listener listener;
    private Credentials credentials;
    private IRokidAudioAiService audioAiService;
    private Intent serviceIntent;
    private ServiceConnection serviceConnection;
    private RecordClientManager recordClientManager;
    private AudioRecord audioRecord;
    private Thread recordThread;
    private volatile boolean recording;
    private volatile boolean canSendPcm;
    private volatile boolean bound;

    RokidAiSdkVoiceBridge(Context context, Listener listener, Credentials credentials) {
        this.appContext = context.getApplicationContext();
        this.listener = listener;
        this.credentials = credentials == null
                ? new Credentials("", "", "", "", "", DEFAULT_WORK_DIR, DEFAULT_CONFIG_FILE)
                : credentials;
    }

    void updateCredentials(Credentials next) {
        credentials = next == null
                ? new Credentials("", "", "", "", "", DEFAULT_WORK_DIR, DEFAULT_CONFIG_FILE)
                : next;
        log("RABI_ROKID_AI_CONFIG:" + credentials.summary());
    }

    ProbeResult probe() {
        boolean assetsReady = assetExists(credentials.workDir + "/" + credentials.configFile);
        boolean nativeAbiReady = hasSupported32BitAbi();
        boolean permission = appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        String summary = "assets=" + assetsReady
                + ";nativeAbi=" + nativeAbiReady
                + ";requiredNativeAbi=armeabi-v7a"
                + ";device32BitAbis=" + join(Build.SUPPORTED_32_BIT_ABIS)
                + ";device64BitAbis=" + join(Build.SUPPORTED_64_BIT_ABIS)
                + ";recordAudioPermission=" + permission
                + ";credentials=" + credentials.summary()
                + ";serviceConnected=" + (audioAiService != null)
                + ";recording=" + recording;
        return new ProbeResult(assetsReady, nativeAbiReady, permission, credentials.isComplete(), audioAiService != null, recording, summary);
    }

    boolean start() {
        ProbeResult probe = probe();
        if (!probe.readyToStart()) {
            String message = "RokidAiSdk not ready: " + probe.summary;
            error("not_ready", message);
            state("not_ready", message);
            return false;
        }
        try {
            serviceIntent = AudioAiConfig.getIndependentIntent(appContext);
            serviceIntent.putExtra(AudioAiConfig.PARAM_SERVICE_START_CONFIG, buildServerConfig());
            recordClientManager = new RecordClientManager(appContext);
            appContext.startService(serviceIntent);
            createConnection();
            bound = appContext.bindService(serviceIntent, serviceConnection, Context.BIND_AUTO_CREATE);
            log("RABI_ROKID_AI_START_REQUESTED:bound=" + bound);
            state(bound ? "starting" : "bind_failed", "service start requested; " + probe.summary);
            return bound;
        } catch (Throwable error) {
            error("start_failed", error.getClass().getSimpleName() + ": " + error.getMessage());
            return false;
        }
    }

    boolean stop() {
        stopRecording();
        boolean stopped = false;
        if (audioAiService != null) {
            try {
                audioAiService.asBinder().unlinkToDeath(deathRecipient, 0);
            } catch (Throwable ignored) {
            }
            audioAiService = null;
            stopped = true;
        }
        if (serviceConnection != null && bound) {
            try {
                appContext.unbindService(serviceConnection);
            } catch (Throwable ignored) {
            }
        }
        bound = false;
        serviceConnection = null;
        if (recordClientManager != null) {
            try {
                recordClientManager.onDestroy();
            } catch (Throwable ignored) {
            }
            recordClientManager = null;
        }
        log("RABI_ROKID_AI_STOP:stopped=" + stopped);
        state("stopped", "serviceStopped=" + stopped);
        return stopped;
    }

    boolean speak(String text) {
        String speech = text == null || text.trim().isEmpty() ? "Rabi Rokid AI SDK TTS 测试" : text.trim();
        if (audioAiService == null) {
            error("tts_not_ready", "RokidAiSdk service is not connected");
            return false;
        }
        try {
            audioAiService.playTtsVoice(speech);
            log("RABI_ROKID_AI_TTS_REQUEST:" + speech);
            listener.onAiSdkTtsRequested(speech);
            return true;
        } catch (Throwable error) {
            error("tts_failed", error.getClass().getSimpleName() + ": " + error.getMessage());
            return false;
        }
    }

    boolean setPickUp(boolean enabled) {
        if (audioAiService == null) {
            error("pickup_not_ready", "RokidAiSdk service is not connected");
            return false;
        }
        try {
            audioAiService.setPickUp(enabled);
            log("RABI_ROKID_AI_PICKUP:" + enabled);
            state(enabled ? "pickup_enabled" : "pickup_disabled", "setPickUp=" + enabled);
            return true;
        } catch (Throwable error) {
            error("pickup_failed", error.getClass().getSimpleName() + ": " + error.getMessage());
            return false;
        }
    }

    boolean setAngle(int angle) {
        if (audioAiService == null) {
            error("angle_not_ready", "RokidAiSdk service is not connected");
            return false;
        }
        try {
            audioAiService.setAngle(angle);
            log("RABI_ROKID_AI_ANGLE:" + angle);
            state("angle_set", "angle=" + angle);
            return true;
        } catch (Throwable error) {
            error("angle_failed", error.getClass().getSimpleName() + ": " + error.getMessage());
            return false;
        }
    }

    boolean isServiceConnected() {
        return audioAiService != null;
    }

    boolean isRecording() {
        return recording;
    }

    private ServerConfig buildServerConfig() {
        ServerConfig config = new ServerConfig(credentials.workDir, credentials.configFile, true);
        config.setLogConfig(Logger.LEVEL_D, true, true);
        config.setKey(credentials.key)
                .setSecret(credentials.secret)
                .setDeviceTypeId(credentials.deviceTypeId)
                .setDeviceId(credentials.deviceId)
                .setSeed(credentials.seed);
        config.setUseNlpConsumer(true);
        return config;
    }

    private void createConnection() {
        if (serviceConnection != null) {
            return;
        }
        serviceConnection = new ServiceConnection() {
            @Override
            public void onServiceConnected(ComponentName name, IBinder service) {
                audioAiService = IRokidAudioAiService.Stub.asInterface(service);
                try {
                    service.linkToDeath(deathRecipient, 0);
                    audioAiService.registAudioAiListener(audioAiListener);
                    log("RABI_ROKID_AI_SERVICE_CONNECTED:" + name.flattenToShortString());
                    state("connected", name.flattenToShortString());
                } catch (Throwable error) {
                    RokidAiSdkVoiceBridge.this.error("listener_register_failed", error.getClass().getSimpleName() + ": " + error.getMessage());
                }
            }

            @Override
            public void onServiceDisconnected(ComponentName name) {
                audioAiService = null;
                log("RABI_ROKID_AI_SERVICE_DISCONNECTED:" + name.flattenToShortString());
                state("disconnected", name.flattenToShortString());
            }
        };
    }

    private final IBinder.DeathRecipient deathRecipient = new IBinder.DeathRecipient() {
        @Override
        public void binderDied() {
            audioAiService = null;
            stopRecording();
            error("binder_died", "RokidAiSdk binder died");
        }
    };

    private final IRokidAudioAiListener audioAiListener = new IRokidAudioAiListener.Stub() {
        private final String listenerKey = FileUtil.getStringID();

        @Override
        public void onIntermediateSlice(int id, String asr, boolean isLocal) {
            log("RABI_ROKID_AI_ASR_PARTIAL:" + safe(asr));
            listener.onAiSdkAsrText(safe(asr), false, isLocal);
        }

        @Override
        public void onIntermediateEntire(int id, String asr, boolean isLocal) {
            log("RABI_ROKID_AI_ASR:" + safe(asr));
            listener.onAiSdkAsrText(safe(asr), true, isLocal);
        }

        @Override
        public void onCompleteNlp(int id, String nlp, String action, boolean isLocal) {
            log("RABI_ROKID_AI_NLP:id=" + id + ";local=" + isLocal + ";nlp=" + safe(nlp) + ";action=" + safe(action));
        }

        @Override
        public void onVoiceEvent(int id, int event, float sl, float energy, String extra) {
            log("RABI_ROKID_AI_EVENT:id=" + id + ";event=" + event + ";sl=" + sl + ";energy=" + energy + ";extra=" + safe(extra));
        }

        @Override
        public void onRecognizeError(int id, int errorCode) {
            error("recognize_error", "id=" + id + ";code=" + errorCode);
        }

        @Override
        public void onServerSocketCreate(String ip, int port) {
            log("RABI_ROKID_AI_SOCKET:ip=" + ip + ";port=" + port);
            startRecording(ip, port);
        }

        @Override
        public void onPcmServerPrepared() {
            log("RABI_ROKID_AI_PCM_SERVER_PREPARED");
        }

        @Override
        public String getKey() throws RemoteException {
            return listenerKey;
        }

        @Override
        public void controlNlpAppExit() {
            log("RABI_ROKID_AI_NLP_APP_EXIT");
        }

        @Override
        public boolean interceptCloudNlpControl(int id, String nlp, String action) {
            log("RABI_ROKID_AI_NLP_CONTROL:id=" + id + ";nlp=" + safe(nlp) + ";action=" + safe(action));
            return false;
        }

        @Override
        public void onVerifyFailed(String deviceTypeId, String deviceId, String seed, String mac) {
            error("verify_failed", "deviceTypeId=" + mask(deviceTypeId) + ";deviceId=" + mask(deviceId) + ";seed=" + mask(seed) + ";mac=" + mask(mac));
        }

        @Override
        public void onRecogniseStatusChange(boolean status) {
            log("RABI_ROKID_AI_RECOGNISE_STATUS:" + status);
            state(status ? "recognising" : "idle", "recogniseStatus=" + status);
        }
    };

    private void startRecording(String ip, int port) {
        if (recording) {
            return;
        }
        if (recordClientManager == null) {
            recordClientManager = new RecordClientManager(appContext);
        }
        try {
            recordClientManager.startSocket(ip, port, connectListener);
        } catch (Throwable error) {
            error("record_socket_failed", error.getClass().getSimpleName() + ": " + error.getMessage());
            return;
        }
        recording = true;
        recordThread = new Thread(() -> {
            int bufferSize = AudioRecord.getMinBufferSize(FREQUENCY, CHANNEL, ENCODING_BIT);
            bufferSize = Math.max(bufferSize * 3, 4096);
            try {
                audioRecord = new AudioRecord(MediaRecorder.AudioSource.MIC, FREQUENCY, CHANNEL, ENCODING_BIT, bufferSize);
                byte[] buffer = new byte[bufferSize];
                audioRecord.startRecording();
                log("RABI_ROKID_AI_RECORDING_STARTED:buffer=" + bufferSize);
                while (recording) {
                    int read = audioRecord.read(buffer, 0, buffer.length);
                    if (read > 0 && canSendPcm && recordClientManager != null) {
                        if (read == buffer.length) {
                            recordClientManager.sendRecordData(buffer);
                        } else {
                            byte[] slice = new byte[read];
                            System.arraycopy(buffer, 0, slice, 0, read);
                            recordClientManager.sendRecordData(slice);
                        }
                    }
                }
            } catch (Throwable error) {
                RokidAiSdkVoiceBridge.this.error("record_failed", error.getClass().getSimpleName() + ": " + error.getMessage());
            } finally {
                releaseAudioRecord();
                log("RABI_ROKID_AI_RECORDING_STOPPED");
            }
        }, "RokidAiSdkRecord");
        recordThread.start();
    }

    private void stopRecording() {
        recording = false;
        canSendPcm = false;
        releaseAudioRecord();
        if (recordThread != null) {
            try {
                recordThread.join(500);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            recordThread = null;
        }
    }

    private void releaseAudioRecord() {
        if (audioRecord == null) {
            return;
        }
        try {
            audioRecord.stop();
        } catch (Throwable ignored) {
        }
        try {
            audioRecord.release();
        } catch (Throwable ignored) {
        }
        audioRecord = null;
    }

    private final ClientSocketManager.IConnnectListener connectListener = new ClientSocketManager.IConnnectListener() {
        @Override
        public void onConnectSuccess(ClientSocketManager socketManager) {
            canSendPcm = true;
            log("RABI_ROKID_AI_RECORD_SOCKET_CONNECTED");
        }

        @Override
        public void onConnectFailed(ClientSocketManager socketManager) {
            canSendPcm = false;
            error("record_socket_connect_failed", "RecordClientManager connect failed");
        }
    };

    private boolean assetExists(String path) {
        try {
            appContext.getAssets().open(path).close();
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static boolean hasSupported32BitAbi() {
        for (String abi : Build.SUPPORTED_32_BIT_ABIS) {
            if ("armeabi-v7a".equals(abi)) {
                return true;
            }
        }
        return false;
    }

    private void state(String state, String detail) {
        listener.onAiSdkState(state, detail == null ? "" : detail);
    }

    private void error(String kind, String message) {
        String safeMessage = message == null ? "" : message;
        log("RABI_ROKID_AI_ERROR:" + kind + ":" + safeMessage);
        listener.onAiSdkError(kind, safeMessage);
    }

    private void log(String line) {
        listener.onAiSdkLog(line);
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static String cleanOrDefault(String value, String fallback) {
        String clean = clean(value);
        return clean.isEmpty() ? fallback : clean;
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }

    private static String join(String[] values) {
        if (values == null || values.length == 0) {
            return "<none>";
        }
        StringBuilder builder = new StringBuilder();
        for (String value : values) {
            if (builder.length() > 0) {
                builder.append(',');
            }
            builder.append(value == null ? "" : value);
        }
        return builder.toString();
    }

    private static String mask(String value) {
        String clean = clean(value);
        if (clean.isEmpty()) {
            return "<empty>";
        }
        return "<set:" + clean.length() + ">";
    }
}
