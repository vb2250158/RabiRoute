package com.rabi.link.modules.rokid;

import android.Manifest;
import android.app.AppOpsManager;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothHeadset;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.speech.RecognitionListener;
import android.speech.RecognitionService;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

final class RokidAndroidSystemVoiceBridge {
    interface Listener {
        void onSystemVoiceLog(String line);

        void onSystemAsrText(String text, boolean finalResult);

        void onSystemTtsAck(String text);

        void onSystemVoiceError(String kind, String message);
    }

    static final class Probe {
        final boolean recordAudioGranted;
        final boolean speechRecognizerAvailable;
        final boolean recognitionServicePresent;
        final boolean onDeviceRecognitionAvailable;
        final boolean ttsReady;
        final String recordAudioAppOpMode;
        final int inputDeviceCount;
        final int outputDeviceCount;
        final String inputDevices;
        final String outputDevices;
        final String defaultRecognitionService;
        final String recognitionServices;
        final String defaultTtsEngine;
        final String ttsServices;
        final boolean bluetoothRouteRequested;
        final String communicationDevice;
        final String communicationDevices;

        Probe(
                boolean recordAudioGranted,
                boolean speechRecognizerAvailable,
                boolean recognitionServicePresent,
                boolean onDeviceRecognitionAvailable,
                boolean ttsReady,
                String recordAudioAppOpMode,
                int inputDeviceCount,
                int outputDeviceCount,
                String inputDevices,
                String outputDevices,
                String defaultRecognitionService,
                String recognitionServices,
                String defaultTtsEngine,
                String ttsServices,
                boolean bluetoothRouteRequested,
                String communicationDevice,
                String communicationDevices
        ) {
            this.recordAudioGranted = recordAudioGranted;
            this.speechRecognizerAvailable = speechRecognizerAvailable;
            this.recognitionServicePresent = recognitionServicePresent;
            this.onDeviceRecognitionAvailable = onDeviceRecognitionAvailable;
            this.ttsReady = ttsReady;
            this.recordAudioAppOpMode = recordAudioAppOpMode;
            this.inputDeviceCount = inputDeviceCount;
            this.outputDeviceCount = outputDeviceCount;
            this.inputDevices = inputDevices;
            this.outputDevices = outputDevices;
            this.defaultRecognitionService = defaultRecognitionService;
            this.recognitionServices = recognitionServices;
            this.defaultTtsEngine = defaultTtsEngine;
            this.ttsServices = ttsServices;
            this.bluetoothRouteRequested = bluetoothRouteRequested;
            this.communicationDevice = communicationDevice;
            this.communicationDevices = communicationDevices;
        }

        boolean readyForAsr() {
            return recordAudioGranted && speechRecognizerAvailable && recognitionServicePresent;
        }

        boolean readyForTts() {
            return ttsReady;
        }

        String summary() {
            return "recordAudio=" + recordAudioGranted +
                    " speechRecognizer=" + speechRecognizerAvailable +
                    " recognitionService=" + recognitionServicePresent +
                    " onDeviceRecognizer=" + onDeviceRecognitionAvailable +
                    " ttsReady=" + ttsReady +
                    " recordAudioAppOp=" + recordAudioAppOpMode +
                    " inputs=" + inputDeviceCount + "[" + inputDevices + "]" +
                    " outputs=" + outputDeviceCount + "[" + outputDevices + "]" +
                    " bluetoothRouteRequested=" + bluetoothRouteRequested +
                    " communicationDevice=" + communicationDevice +
                    " communicationDevices=" + communicationDevices +
                    " defaultAsr=" + defaultRecognitionService +
                    " asrServices=" + recognitionServices +
                    " defaultTts=" + defaultTtsEngine +
                    " ttsServices=" + ttsServices;
        }
    }

    private static final String SYSTEM_TTS_UTTERANCE_ID = "rabi-android-system-tts";

    private final Context appContext;
    private final Listener listener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer speechRecognizer;
    private TextToSpeech textToSpeech;
    private boolean ttsReady;
    private boolean bluetoothRouteRequested;
    private BluetoothHeadset bluetoothHeadsetProxy;
    private String lastTtsText = "";

    RokidAndroidSystemVoiceBridge(Context context, Listener listener) {
        this.appContext = context.getApplicationContext();
        this.listener = listener;
    }

    void start() {
        if (textToSpeech != null) {
            return;
        }
        textToSpeech = new TextToSpeech(appContext, status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (ttsReady) {
                int language = textToSpeech.setLanguage(Locale.CHINESE);
                textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override
                    public void onStart(String utteranceId) {
                        log("Android system TTS onStart utterance=" + utteranceId);
                    }

                    @Override
                    public void onDone(String utteranceId) {
                        log("Android system TTS onDone utterance=" + utteranceId);
                        listener.onSystemTtsAck(lastTtsText);
                    }

                    @Override
                    public void onError(String utteranceId) {
                        log("Android system TTS onError utterance=" + utteranceId);
                        listener.onSystemVoiceError("android_tts", "onError utterance=" + utteranceId);
                    }
                });
                log("Android system TTS init success language=" + language);
            } else {
                log("Android system TTS init failed status=" + status);
                listener.onSystemVoiceError("android_tts", "init status=" + status);
            }
        });
    }

    void stop() {
        stopAsr();
        if (textToSpeech != null) {
            textToSpeech.stop();
            textToSpeech.shutdown();
            textToSpeech = null;
        }
        ttsReady = false;
        if (bluetoothHeadsetProxy != null) {
            try {
                BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
                if (adapter != null) {
                    adapter.closeProfileProxy(BluetoothProfile.HEADSET, bluetoothHeadsetProxy);
                }
            } catch (RuntimeException ignored) {
            }
            bluetoothHeadsetProxy = null;
        }
    }

    Probe probe() {
        AudioManager audioManager = (AudioManager) appContext.getSystemService(Context.AUDIO_SERVICE);
        AudioDeviceInfo[] inputs = audioManager == null ? new AudioDeviceInfo[0] : audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS);
        AudioDeviceInfo[] outputs = audioManager == null ? new AudioDeviceInfo[0] : audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
        PackageManager packageManager = appContext.getPackageManager();
        boolean recordAudioGranted = appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        boolean speechRecognizerAvailable = SpeechRecognizer.isRecognitionAvailable(appContext);
        String recognitionServices = describeServices(packageManager, RecognitionService.SERVICE_INTERFACE);
        boolean recognitionServicePresent = speechRecognizerAvailable || !"none".equals(recognitionServices);
        boolean onDeviceRecognitionAvailable = false;
        SpeechRecognizer onDeviceRecognizer = null;
        try {
            onDeviceRecognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext);
            onDeviceRecognitionAvailable = onDeviceRecognizer != null;
        } catch (Throwable error) {
            log("Android system on-device recognizer unavailable " + error.getClass().getSimpleName() + ": " + error.getMessage());
        } finally {
            if (onDeviceRecognizer != null) {
                onDeviceRecognizer.destroy();
            }
        }
        Probe probe = new Probe(
                recordAudioGranted,
                speechRecognizerAvailable,
                recognitionServicePresent,
                onDeviceRecognitionAvailable,
                ttsReady,
                recordAudioAppOpMode(),
                inputs.length,
                outputs.length,
                describeDevices(inputs),
                describeDevices(outputs),
                secureSetting("voice_recognition_service"),
                recognitionServices,
                secureSetting("tts_default_synth"),
                describeServices(packageManager, TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE),
                bluetoothRouteRequested,
                describeCommunicationDevice(audioManager),
                describeCommunicationDevices(audioManager)
        );
        log("Android system voice probe " + probe.summary());
        return probe;
    }

    boolean startAsr() {
        Probe probe = probe();
        if (!probe.readyForAsr()) {
            listener.onSystemVoiceError("android_asr", "not ready: " + probe.summary());
            return false;
        }
        return runOnMain(() -> {
            stopAsr();
            if (bluetoothRouteRequested) {
                routeBluetoothForSystemVoice();
            }
            speechRecognizer = SpeechRecognizer.createSpeechRecognizer(appContext);
            speechRecognizer.setRecognitionListener(new RecognitionListener() {
                @Override
                public void onReadyForSpeech(Bundle params) {
                    log("Android system ASR readyForSpeech");
                }

                @Override
                public void onBeginningOfSpeech() {
                    log("Android system ASR beginningOfSpeech");
                }

                @Override
                public void onRmsChanged(float rmsdB) {
                    // Too noisy for fixed log; final/partial text is the useful evidence.
                }

                @Override
                public void onBufferReceived(byte[] buffer) {
                    log("Android system ASR buffer bytes=" + (buffer == null ? 0 : buffer.length));
                }

                @Override
                public void onEndOfSpeech() {
                    log("Android system ASR endOfSpeech");
                }

                @Override
                public void onError(int error) {
                    log("Android system ASR error code=" + error + " name=" + asrErrorName(error));
                    listener.onSystemVoiceError("android_asr", "errorCode=" + error + " " + asrErrorName(error));
                }

                @Override
                public void onResults(Bundle results) {
                    String text = firstRecognitionText(results);
                    log("Android system ASR final=" + text);
                    listener.onSystemAsrText(text, true);
                }

                @Override
                public void onPartialResults(Bundle partialResults) {
                    String text = firstRecognitionText(partialResults);
                    log("Android system ASR partial=" + text);
                    listener.onSystemAsrText(text, false);
                }

                @Override
                public void onEvent(int eventType, Bundle params) {
                    log("Android system ASR event=" + eventType);
                }
            });
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.CHINESE.toLanguageTag());
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, appContext.getPackageName());
            speechRecognizer.startListening(intent);
            log("Android system ASR startListening requested");
        });
    }

    boolean stopAsr() {
        return runOnMain(() -> {
            if (speechRecognizer != null) {
                try {
                    speechRecognizer.stopListening();
                } catch (RuntimeException ignored) {
                    // SpeechRecognizer can reject stop when the service has already ended the session.
                }
                try {
                    speechRecognizer.cancel();
                } catch (RuntimeException ignored) {
                    // Same lifecycle race as stopListening.
                }
                try {
                    speechRecognizer.destroy();
                } catch (RuntimeException ignored) {
                    // Destroy is best-effort during activity teardown.
                }
                speechRecognizer = null;
                log("Android system ASR stopped");
            }
        });
    }

    boolean speak(String text) {
        start();
        if (!ttsReady || textToSpeech == null) {
            listener.onSystemVoiceError("android_tts", "TTS not ready");
            return false;
        }
        if (bluetoothRouteRequested) {
            routeBluetoothForSystemVoice();
        }
        lastTtsText = text == null ? "" : text;
        int result = textToSpeech.speak(lastTtsText, TextToSpeech.QUEUE_FLUSH, null, SYSTEM_TTS_UTTERANCE_ID);
        log("Android system TTS speak requested result=" + result + " text=" + lastTtsText);
        return result == TextToSpeech.SUCCESS;
    }

    boolean routeBluetoothForSystemVoice() {
        bluetoothRouteRequested = true;
        AudioManager audioManager = (AudioManager) appContext.getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) {
            listener.onSystemVoiceError("android_audio_route", "AudioManager unavailable");
            return false;
        }
        boolean routed = false;
        String target = "none";
        try {
            audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                List<AudioDeviceInfo> devices = audioManager.getAvailableCommunicationDevices();
                for (AudioDeviceInfo device : devices) {
                    if (isBluetoothVoiceDevice(device)) {
                        target = deviceTypeName(device.getType()) + ":" + safeProductName(device);
                        routed = audioManager.setCommunicationDevice(device);
                        break;
                    }
                }
            }
            if (!routed) {
                audioManager.startBluetoothSco();
                audioManager.setBluetoothScoOn(true);
                routed = audioManager.isBluetoothScoOn();
                target = target + ";scoOn=" + routed;
            }
            log("Android system voice Bluetooth route requested routed=" + routed
                    + " target=" + target
                    + " communicationDevice=" + describeCommunicationDevice(audioManager)
                    + " communicationDevices=" + describeCommunicationDevices(audioManager));
            if (!routed) {
                listener.onSystemVoiceError("android_audio_route", "bluetooth route not active target=" + target);
            }
            return routed;
        } catch (RuntimeException error) {
            listener.onSystemVoiceError("android_audio_route", error.getClass().getSimpleName() + ": " + error.getMessage());
            log("Android system voice Bluetooth route failed " + error.getClass().getSimpleName() + ": " + error.getMessage());
            return false;
        }
    }

    boolean startBluetoothHeadsetVoiceRecognition() {
        bluetoothRouteRequested = true;
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) {
            listener.onSystemVoiceError("android_bt_headset", "BluetoothAdapter unavailable");
            return false;
        }
        try {
            boolean requested = adapter.getProfileProxy(appContext, new BluetoothProfile.ServiceListener() {
                @Override
                public void onServiceConnected(int profile, BluetoothProfile proxy) {
                    if (profile != BluetoothProfile.HEADSET || !(proxy instanceof BluetoothHeadset)) {
                        log("Android Bluetooth profile connected but not HEADSET profile=" + profile);
                        return;
                    }
                    bluetoothHeadsetProxy = (BluetoothHeadset) proxy;
                    List<BluetoothDevice> connected = bluetoothHeadsetProxy.getConnectedDevices();
                    BluetoothDevice target = chooseLikelyBluetoothDevice(connected);
                    String targetSource = "connected";
                    List<BluetoothDevice> bonded = new ArrayList<>();
                    if (target == null) {
                        bonded = getBondedDevicesList();
                        target = chooseLikelyBluetoothDevice(bonded);
                        targetSource = "bonded";
                    }
                    if (target == null) {
                        log("Android Bluetooth HEADSET no Rokid target connected=" + describeBluetoothDevices(connected)
                                + " bonded=" + describeBluetoothDevices(bonded));
                        listener.onSystemVoiceError("android_bt_headset", "no Rokid/Glass headset device; connected="
                                + describeBluetoothDevices(connected) + " bonded=" + describeBluetoothDevices(bonded));
                        return;
                    }
                    boolean voiceStarted = false;
                    try {
                        voiceStarted = bluetoothHeadsetProxy.startVoiceRecognition(target);
                    } catch (RuntimeException error) {
                        listener.onSystemVoiceError("android_bt_headset", "startVoiceRecognition " + error.getClass().getSimpleName() + ": " + error.getMessage());
                    }
                    log("Android Bluetooth HEADSET voice recognition requested=" + voiceStarted
                            + " target=" + describeBluetoothDevice(target)
                            + " source=" + targetSource
                            + " headsetState=" + describeHeadsetConnectionState(bluetoothHeadsetProxy, target)
                            + " connected=" + describeBluetoothDevices(connected)
                            + " bonded=" + describeBluetoothDevices(bonded));
                    if (voiceStarted) {
                        routeBluetoothForSystemVoice();
                    } else {
                        listener.onSystemVoiceError("android_bt_headset", "startVoiceRecognition returned false target="
                                + describeBluetoothDevice(target)
                                + " source=" + targetSource
                                + " headsetState=" + describeHeadsetConnectionState(bluetoothHeadsetProxy, target));
                    }
                }

                @Override
                public void onServiceDisconnected(int profile) {
                    if (profile == BluetoothProfile.HEADSET) {
                        log("Android Bluetooth HEADSET profile disconnected");
                        bluetoothHeadsetProxy = null;
                    }
                }
            }, BluetoothProfile.HEADSET);
            log("Android Bluetooth HEADSET profile proxy requested=" + requested);
            if (!requested) {
                listener.onSystemVoiceError("android_bt_headset", "getProfileProxy returned false");
            }
            return requested;
        } catch (RuntimeException error) {
            listener.onSystemVoiceError("android_bt_headset", error.getClass().getSimpleName() + ": " + error.getMessage());
            log("Android Bluetooth HEADSET profile request failed " + error.getClass().getSimpleName() + ": " + error.getMessage());
            return false;
        }
    }

    boolean stopBluetoothHeadsetVoiceRecognition() {
        bluetoothRouteRequested = false;
        boolean stopped = false;
        try {
            if (bluetoothHeadsetProxy != null) {
                List<BluetoothDevice> connected = bluetoothHeadsetProxy.getConnectedDevices();
                BluetoothDevice target = chooseLikelyBluetoothDevice(connected);
                if (target != null) {
                    stopped = bluetoothHeadsetProxy.stopVoiceRecognition(target);
                    log("Android Bluetooth HEADSET voice recognition stop requested=" + stopped
                            + " target=" + describeBluetoothDevice(target)
                            + " headsetState=" + describeHeadsetConnectionState(bluetoothHeadsetProxy, target));
                } else {
                    log("Android Bluetooth HEADSET stop skipped no target devices=" + describeBluetoothDevices(connected));
                }
            }
        } catch (RuntimeException error) {
            listener.onSystemVoiceError("android_bt_headset", "stopVoiceRecognition " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        clearBluetoothRoute();
        return stopped;
    }

    boolean clearBluetoothRoute() {
        bluetoothRouteRequested = false;
        AudioManager audioManager = (AudioManager) appContext.getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) {
            return false;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice();
            }
            audioManager.setBluetoothScoOn(false);
            audioManager.stopBluetoothSco();
            audioManager.setMode(AudioManager.MODE_NORMAL);
            log("Android system voice Bluetooth route cleared communicationDevice=" + describeCommunicationDevice(audioManager));
            return true;
        } catch (RuntimeException error) {
            listener.onSystemVoiceError("android_audio_route", "clear failed " + error.getClass().getSimpleName() + ": " + error.getMessage());
            return false;
        }
    }

    private boolean runOnMain(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action.run();
            return true;
        }
        mainHandler.post(action);
        return true;
    }

    private String firstRecognitionText(Bundle bundle) {
        if (bundle == null) {
            return "";
        }
        ArrayList<String> values = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (values == null || values.isEmpty()) {
            return "";
        }
        return values.get(0) == null ? "" : values.get(0);
    }

    private String asrErrorName(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "ERROR_AUDIO";
            case SpeechRecognizer.ERROR_CLIENT:
                return "ERROR_CLIENT";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "ERROR_INSUFFICIENT_PERMISSIONS";
            case SpeechRecognizer.ERROR_NETWORK:
                return "ERROR_NETWORK";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "ERROR_NETWORK_TIMEOUT";
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "ERROR_NO_MATCH";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "ERROR_RECOGNIZER_BUSY";
            case SpeechRecognizer.ERROR_SERVER:
                return "ERROR_SERVER";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "ERROR_SPEECH_TIMEOUT";
            default:
                return "ERROR_" + error;
        }
    }

    private String describeDevices(AudioDeviceInfo[] devices) {
        if (devices == null || devices.length == 0) {
            return "none";
        }
        List<String> descriptions = new ArrayList<>();
        for (AudioDeviceInfo device : devices) {
            descriptions.add(deviceTypeName(device.getType()) + ":" + safeProductName(device));
        }
        return String.join(",", descriptions);
    }

    private String describeCommunicationDevice(AudioManager audioManager) {
        if (audioManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return "unavailable";
        }
        try {
            AudioDeviceInfo device = audioManager.getCommunicationDevice();
            return device == null ? "none" : deviceTypeName(device.getType()) + ":" + safeProductName(device);
        } catch (RuntimeException error) {
            return "unavailable:" + error.getClass().getSimpleName();
        }
    }

    private String describeCommunicationDevices(AudioManager audioManager) {
        if (audioManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return "unavailable";
        }
        try {
            List<AudioDeviceInfo> devices = audioManager.getAvailableCommunicationDevices();
            if (devices == null || devices.isEmpty()) {
                return "none";
            }
            List<String> descriptions = new ArrayList<>();
            for (AudioDeviceInfo device : devices) {
                descriptions.add(deviceTypeName(device.getType()) + ":" + safeProductName(device));
            }
            return String.join(",", descriptions);
        } catch (RuntimeException error) {
            return "unavailable:" + error.getClass().getSimpleName();
        }
    }

    private boolean isBluetoothVoiceDevice(AudioDeviceInfo device) {
        if (device == null) {
            return false;
        }
        int type = device.getType();
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET);
    }

    private BluetoothDevice chooseLikelyBluetoothDevice(List<BluetoothDevice> devices) {
        if (devices != null) {
            for (BluetoothDevice device : devices) {
                if (isLikelyRokidDevice(device)) {
                    return device;
                }
            }
            if (!devices.isEmpty()) {
                return devices.get(0);
            }
        }
        return null;
    }

    private List<BluetoothDevice> getBondedDevicesList() {
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) {
            return new ArrayList<>();
        }
        try {
            Set<BluetoothDevice> bonded = adapter.getBondedDevices();
            if (bonded == null) {
                return new ArrayList<>();
            }
            return new ArrayList<>(bonded);
        } catch (SecurityException error) {
            listener.onSystemVoiceError("android_bt_headset", "bonded devices permission " + error.getClass().getSimpleName());
        }
        return new ArrayList<>();
    }

    private boolean isLikelyRokidDevice(BluetoothDevice device) {
        String name = safeBluetoothName(device);
        String lower = name.toLowerCase(Locale.ROOT);
        return lower.contains("rokid") || lower.contains("glass") || lower.contains("glasses");
    }

    private String describeBluetoothDevices(List<BluetoothDevice> devices) {
        if (devices == null || devices.isEmpty()) {
            return "none";
        }
        List<String> descriptions = new ArrayList<>();
        for (BluetoothDevice device : devices) {
            descriptions.add(describeBluetoothDevice(device));
        }
        return String.join(",", descriptions);
    }

    private String describeBluetoothDevice(BluetoothDevice device) {
        if (device == null) {
            return "null";
        }
        return "name=" + safeBluetoothName(device) + " addressSuffix=" + safeAddressSuffix(device);
    }

    private String describeHeadsetConnectionState(BluetoothHeadset headset, BluetoothDevice device) {
        if (headset == null || device == null) {
            return "unknown";
        }
        try {
            int state = headset.getConnectionState(device);
            switch (state) {
                case BluetoothProfile.STATE_CONNECTED:
                    return "connected";
                case BluetoothProfile.STATE_CONNECTING:
                    return "connecting";
                case BluetoothProfile.STATE_DISCONNECTED:
                    return "disconnected";
                case BluetoothProfile.STATE_DISCONNECTING:
                    return "disconnecting";
                default:
                    return "state_" + state;
            }
        } catch (RuntimeException error) {
            return "unavailable:" + error.getClass().getSimpleName();
        }
    }

    private String safeBluetoothName(BluetoothDevice device) {
        if (device == null) {
            return "unknown";
        }
        try {
            String name = device.getName();
            return name == null || name.trim().isEmpty() ? "unknown" : name.trim();
        } catch (SecurityException error) {
            return "permissionRequired";
        }
    }

    private String safeAddressSuffix(BluetoothDevice device) {
        if (device == null) {
            return "unknown";
        }
        try {
            String address = device.getAddress();
            if (address == null || address.length() < 5) {
                return "unknown";
            }
            return address.substring(address.length() - 5);
        } catch (SecurityException error) {
            return "permissionRequired";
        }
    }

    private String describeServices(PackageManager packageManager, String action) {
        if (packageManager == null) {
            return "pmUnavailable";
        }
        Intent intent = new Intent(action);
        List<ResolveInfo> services = packageManager.queryIntentServices(intent, 0);
        if (services == null || services.isEmpty()) {
            return "none";
        }
        List<String> names = new ArrayList<>();
        for (ResolveInfo service : services) {
            if (service == null || service.serviceInfo == null) {
                continue;
            }
            names.add(service.serviceInfo.packageName + "/" + service.serviceInfo.name);
        }
        return names.isEmpty() ? "none" : String.join(",", names);
    }

    private String secureSetting(String name) {
        try {
            String value = Settings.Secure.getString(appContext.getContentResolver(), name);
            return value == null || value.trim().isEmpty() ? "none" : value;
        } catch (RuntimeException error) {
            return "unavailable:" + error.getClass().getSimpleName();
        }
    }

    private String recordAudioAppOpMode() {
        AppOpsManager appOpsManager = (AppOpsManager) appContext.getSystemService(Context.APP_OPS_SERVICE);
        if (appOpsManager == null) {
            return "unavailable";
        }
        try {
            int mode = appOpsManager.unsafeCheckOpNoThrow(
                    AppOpsManager.OPSTR_RECORD_AUDIO,
                    Process.myUid(),
                    appContext.getPackageName()
            );
            return appOpsModeName(mode);
        } catch (RuntimeException error) {
            return "unavailable:" + error.getClass().getSimpleName();
        }
    }

    private String appOpsModeName(int mode) {
        switch (mode) {
            case AppOpsManager.MODE_ALLOWED:
                return "allowed";
            case AppOpsManager.MODE_IGNORED:
                return "ignored";
            case AppOpsManager.MODE_ERRORED:
                return "errored";
            case AppOpsManager.MODE_DEFAULT:
                return "default";
            case AppOpsManager.MODE_FOREGROUND:
                return "foreground";
            default:
                return "mode_" + mode;
        }
    }

    private String safeProductName(AudioDeviceInfo device) {
        CharSequence productName = device.getProductName();
        if (productName == null) {
            return "unknown";
        }
        String name = productName.toString().trim();
        if (name.contains("Rokid") || name.contains("Glasses")) {
            return name;
        }
        if (device.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                device.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) {
            return "bluetoothDevice";
        }
        return "systemDevice";
    }

    private String deviceTypeName(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
                return "BLUETOOTH_A2DP";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                return "BLUETOOTH_SCO";
            case AudioDeviceInfo.TYPE_BUILTIN_MIC:
                return "BUILTIN_MIC";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                return "BUILTIN_SPEAKER";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                return "WIRED_HEADSET";
            case AudioDeviceInfo.TYPE_USB_HEADSET:
                return "USB_HEADSET";
            case AudioDeviceInfo.TYPE_TELEPHONY:
                return "TELEPHONY";
            default:
                return "TYPE_" + type;
        }
    }

    private void log(String line) {
        listener.onSystemVoiceLog(line);
    }
}
