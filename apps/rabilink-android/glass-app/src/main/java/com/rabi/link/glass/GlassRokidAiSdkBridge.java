package com.rabi.link.glass;

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

import com.rokid.ai.basic.AudioAiConfig;
import com.rokid.ai.basic.aidl.IRokidAudioAiListener;
import com.rokid.ai.basic.aidl.IRokidAudioAiService;
import com.rokid.ai.basic.aidl.ServerConfig;
import com.rokid.ai.basic.socket.base.ClientSocketManager;
import com.rokid.ai.basic.socket.business.record.RecordClientManager;
import com.rokid.ai.basic.util.FileUtil;
import com.rokid.ai.basic.util.Logger;

final class GlassRokidAiSdkBridge {
    static final String DEFAULT_WORK_DIR = "workdir_asr_cn";
    static final String DEFAULT_CONFIG_FILE = "lothal_single.ini";

    interface Listener {
        void onAiSdkPayload(String payload);

        void onAiSdkLog(String line);
    }

    static final class Credentials {
        final String key;
        final String secret;
        final String deviceTypeId;
        final String deviceId;
        final String seed;
        final String workDir;
        final String configFile;

        Credentials(String key, String secret, String deviceTypeId, String deviceId, String seed, String workDir, String configFile) {
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
            return builder.length() == 0 ? "none" : builder.toString();
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

    private static final int FREQUENCY = 16000;
    private static final int CHANNEL = AudioFormat.CHANNEL_IN_MONO;
    private static final int ENCODING_BIT = AudioFormat.ENCODING_PCM_16BIT;

    private final Context appContext;
    private final Listener listener;
    private Credentials credentials = new Credentials("", "", "", "", "", DEFAULT_WORK_DIR, DEFAULT_CONFIG_FILE);
    private IRokidAudioAiService audioAiService;
    private Intent serviceIntent;
    private ServiceConnection serviceConnection;
    private RecordClientManager recordClientManager;
    private AudioRecord audioRecord;
    private Thread recordThread;
    private volatile boolean bound;
    private volatile boolean recording;
    private volatile boolean canSendPcm;

    GlassRokidAiSdkBridge(Context context, Listener listener) {
        this.appContext = context.getApplicationContext();
        this.listener = listener;
    }

    void updateCredentials(Credentials credentials) {
        if (credentials == null) {
            this.credentials = new Credentials("", "", "", "", "", DEFAULT_WORK_DIR, DEFAULT_CONFIG_FILE);
        } else {
            this.credentials = credentials;
        }
        payload("RABI_ROKID_AI_STATUS:" + readinessSummary());
    }

    void clearCredentials() {
        updateCredentials(new Credentials("", "", "", "", "", DEFAULT_WORK_DIR, DEFAULT_CONFIG_FILE));
    }

    String readinessSummary() {
        boolean assetsReady = assetExists(credentials.workDir + "/" + credentials.configFile);
        boolean nativeAbiReady = hasArmeabiV7a();
        boolean recordAudio = appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        return "assets=" + assetsReady
                + ";nativeAbi=" + nativeAbiReady
                + ";requiredNativeAbi=armeabi-v7a"
                + ";device32BitAbis=" + join(Build.SUPPORTED_32_BIT_ABIS)
                + ";device64BitAbis=" + join(Build.SUPPORTED_64_BIT_ABIS)
                + ";recordAudioPermission=" + recordAudio
                + ";credentials=" + credentials.summary()
                + ";serviceConnected=" + (audioAiService != null)
                + ";bound=" + bound
                + ";recording=" + recording;
    }

    boolean start() {
        String readiness = readinessSummary();
        if (!readyToStart()) {
            payload("RABI_ROKID_AI_ERROR:not_ready:" + readiness);
            payload("RABI_ROKID_AI_STATUS:" + readiness);
            log("RokidAiSdk eye probe not ready " + readiness);
            return false;
        }
        try {
            serviceIntent = AudioAiConfig.getIndependentIntent(appContext);
            serviceIntent.putExtra(AudioAiConfig.PARAM_SERVICE_START_CONFIG, buildServerConfig());
            recordClientManager = new RecordClientManager(appContext);
            appContext.startService(serviceIntent);
            createConnection();
            bound = appContext.bindService(serviceIntent, serviceConnection, Context.BIND_AUTO_CREATE);
            payload("RABI_ROKID_AI_STATE:starting;bound=" + bound);
            return bound;
        } catch (Throwable error) {
            payload("RABI_ROKID_AI_ERROR:start_failed:" + error.getClass().getSimpleName() + ": " + safe(error.getMessage()));
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
        if (bound && serviceConnection != null) {
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
        payload("RABI_ROKID_AI_STATE:stopped;serviceStopped=" + stopped);
        return stopped;
    }

    boolean speak(String text) {
        String speech = text == null || text.trim().isEmpty() ? "Rabi 眼镜 RokidAiSdk TTS 测试" : text.trim();
        if (audioAiService == null) {
            payload("RABI_ROKID_AI_ERROR:tts_not_ready:service is not connected");
            return false;
        }
        try {
            audioAiService.playTtsVoice(speech);
            payload("RABI_ROKID_AI_TTS_REQUEST:" + speech);
            return true;
        } catch (Throwable error) {
            payload("RABI_ROKID_AI_ERROR:tts_failed:" + error.getClass().getSimpleName() + ": " + safe(error.getMessage()));
            return false;
        }
    }

    void destroy() {
        stop();
    }

    private boolean readyToStart() {
        return assetExists(credentials.workDir + "/" + credentials.configFile)
                && hasArmeabiV7a()
                && appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                && credentials.isComplete();
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
                    payload("RABI_ROKID_AI_STATE:connected;service=" + name.flattenToShortString());
                } catch (Throwable error) {
                    payload("RABI_ROKID_AI_ERROR:listener_register_failed:" + error.getClass().getSimpleName() + ": " + safe(error.getMessage()));
                }
            }

            @Override
            public void onServiceDisconnected(ComponentName name) {
                audioAiService = null;
                payload("RABI_ROKID_AI_STATE:disconnected;service=" + name.flattenToShortString());
            }
        };
    }

    private final IBinder.DeathRecipient deathRecipient = new IBinder.DeathRecipient() {
        @Override
        public void binderDied() {
            audioAiService = null;
            stopRecording();
            payload("RABI_ROKID_AI_ERROR:binder_died:RokidAiSdk binder died");
        }
    };

    private final IRokidAudioAiListener audioAiListener = new IRokidAudioAiListener.Stub() {
        private final String listenerKey = FileUtil.getStringID();

        @Override
        public void onIntermediateSlice(int id, String asr, boolean isLocal) {
            payload("RABI_ROKID_AI_ASR_PARTIAL:" + safe(asr));
        }

        @Override
        public void onIntermediateEntire(int id, String asr, boolean isLocal) {
            payload("RABI_ROKID_AI_ASR:" + safe(asr));
        }

        @Override
        public void onCompleteNlp(int id, String nlp, String action, boolean isLocal) {
            payload("RABI_ROKID_AI_NLP:id=" + id + ";local=" + isLocal + ";nlp=" + safe(nlp) + ";action=" + safe(action));
        }

        @Override
        public void onVoiceEvent(int id, int event, float sl, float energy, String extra) {
            payload("RABI_ROKID_AI_EVENT:id=" + id + ";event=" + event + ";sl=" + sl + ";energy=" + energy + ";extra=" + safe(extra));
        }

        @Override
        public void onRecognizeError(int id, int errorCode) {
            payload("RABI_ROKID_AI_ERROR:recognize_error:id=" + id + ";code=" + errorCode);
        }

        @Override
        public void onServerSocketCreate(String ip, int port) {
            payload("RABI_ROKID_AI_SOCKET:ip=" + ip + ";port=" + port);
            startRecording(ip, port);
        }

        @Override
        public void onPcmServerPrepared() {
            payload("RABI_ROKID_AI_STATE:pcm_server_prepared");
        }

        @Override
        public String getKey() {
            return listenerKey;
        }

        @Override
        public void controlNlpAppExit() {
            payload("RABI_ROKID_AI_STATE:nlp_app_exit");
        }

        @Override
        public boolean interceptCloudNlpControl(int id, String nlp, String action) {
            payload("RABI_ROKID_AI_NLP_CONTROL:id=" + id + ";nlp=" + safe(nlp) + ";action=" + safe(action));
            return false;
        }

        @Override
        public void onVerifyFailed(String deviceTypeId, String deviceId, String seed, String mac) {
            payload("RABI_ROKID_AI_ERROR:verify_failed:deviceTypeId=" + mask(deviceTypeId)
                    + ";deviceId=" + mask(deviceId)
                    + ";seed=" + mask(seed)
                    + ";mac=" + mask(mac));
        }

        @Override
        public void onRecogniseStatusChange(boolean status) {
            payload("RABI_ROKID_AI_STATE:recogniseStatus=" + status);
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
            payload("RABI_ROKID_AI_ERROR:record_socket_failed:" + error.getClass().getSimpleName() + ": " + safe(error.getMessage()));
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
                payload("RABI_ROKID_AI_STATE:recording_started;buffer=" + bufferSize);
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
                payload("RABI_ROKID_AI_ERROR:record_failed:" + error.getClass().getSimpleName() + ": " + safe(error.getMessage()));
            } finally {
                releaseAudioRecord();
                payload("RABI_ROKID_AI_STATE:recording_stopped");
            }
        }, "GlassRokidAiSdkRecord");
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
            payload("RABI_ROKID_AI_STATE:record_socket_connected");
        }

        @Override
        public void onConnectFailed(ClientSocketManager socketManager) {
            canSendPcm = false;
            payload("RABI_ROKID_AI_ERROR:record_socket_connect_failed:RecordClientManager connect failed");
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

    private static boolean hasArmeabiV7a() {
        for (String abi : Build.SUPPORTED_32_BIT_ABIS) {
            if ("armeabi-v7a".equals(abi)) {
                return true;
            }
        }
        return false;
    }

    private void payload(String payload) {
        listener.onAiSdkPayload(payload);
        log(payload);
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
            return "none";
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
            return "empty";
        }
        return "set:" + clean.length();
    }
}
