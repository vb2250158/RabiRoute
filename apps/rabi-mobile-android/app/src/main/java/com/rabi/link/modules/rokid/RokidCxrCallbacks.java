package com.rabi.link.modules.rokid;

import com.rokid.cxr.link.CXRLink;
import com.rokid.cxr.link.callbacks.IAudioStreamCbk;
import com.rokid.cxr.link.callbacks.ICXRLinkCbk;
import com.rokid.cxr.link.callbacks.ICustomViewCbk;
import com.rokid.cxr.link.callbacks.IImageStreamCbk;
import com.rokid.cxr.link.utils.GlassInfo;

final class RokidCxrCallbacks {
    private RokidCxrCallbacks() {
    }

    static void install(
            CXRLink cxrLink,
            RokidCxrLinkState linkState,
            RokidAudioCapture audioCapture,
            RokidCxrController.Listener listener
    ) {
        cxrLink.setCXRLinkCbk(new ICXRLinkCbk() {
            @Override
            public void onCXRLConnected(boolean connected) {
                linkState.setCxrConnected(connected);
                log(listener, "onCXRLConnected=" + connected);
                listener.onCxrConnectionChanged(connected);
            }

            @Override
            public void onGlassBtConnected(boolean connected) {
                linkState.setGlassBtConnected(connected);
                log(listener, "onGlassBtConnected=" + connected);
                listener.onGlassBtConnectionChanged(connected);
            }

            @Override
            public void onGlassDeviceInfo(GlassInfo info) {
                log(listener, "onGlassDeviceInfo=" + RokidProbeText.formatGlassInfo(info));
                listener.onGlassDeviceInfo(info);
            }

            @Override
            public void onGlassWearingStatus(boolean wearing) {
                log(listener, "onGlassWearingStatus=" + wearing);
            }

            @Override
            public void onGlassAiAssistStart() {
                log(listener, "onGlassAiAssistStart");
            }

            @Override
            public void onGlassAiAssistStop() {
                log(listener, "onGlassAiAssistStop");
            }

            @Override
            public void onGlassAiInterrupt(boolean interrupted) {
                log(listener, "onGlassAiInterrupt=" + interrupted);
            }

            @Override
            public void onGlassLauncherResume() {
                log(listener, "onGlassLauncherResume");
            }
        });
        cxrLink.setCXRCustomViewCbk(new ICustomViewCbk() {
            @Override
            public void onCustomViewOpened() {
                linkState.setCustomViewOpened(true);
                log(listener, "onCustomViewOpened");
            }

            @Override
            public void onCustomViewUpdated() {
                log(listener, "onCustomViewUpdated");
            }

            @Override
            public void onCustomViewClosed() {
                linkState.setCustomViewOpened(false);
                log(listener, "onCustomViewClosed");
            }

            @Override
            public void onCustomViewIconsSent() {
                log(listener, "onCustomViewIconsSent");
            }

            @Override
            public void onCustomViewError(int code, String message) {
                linkState.setCustomViewOpened(false);
                log(listener, "onCustomViewError code=" + code + " message=" + message);
            }
        });
        installAudioCallback(cxrLink, audioCapture, listener);
        cxrLink.setCXRImageCbk(new IImageStreamCbk() {
            @Override
            public void onImageReceived(byte[] data) {
                log(listener, "onImageReceived bytes=" + (data == null ? 0 : data.length));
                if (data != null && data.length > 0) {
                    listener.onPhoto(data);
                }
            }

            @Override
            public void onImageError(int code, String message) {
                log(listener, "onImageError code=" + code + " message=" + message);
            }
        });
    }

    static void installAudioCallback(
            CXRLink cxrLink,
            RokidAudioCapture audioCapture,
            RokidCxrController.Listener listener
    ) {
        cxrLink.setCXRAudioCbk(new IAudioStreamCbk() {
            private int lastLoggedBytes;

            @Override
            public void onAudioReceived(byte[] data, int offset, int length) {
                audioCapture.append(data, offset, length);
                listener.onAudioPcm(data, offset, length);
                int total = audioCapture.bytes();
                if (total < lastLoggedBytes) {
                    lastLoggedBytes = 0;
                }
                if (total > 0 && (lastLoggedBytes == 0 || total - lastLoggedBytes >= 65536)) {
                    lastLoggedBytes = total;
                    log(listener, "onAudioReceived totalBytes=" + total + " chunkLength=" + length);
                }
            }

            @Override
            public void onAudioError(int code, String message) {
                log(listener, "onAudioError code=" + code + " message=" + message);
            }

            @Override
            public void onAudioStreamStateChanged(boolean started) {
                log(listener, "onAudioStreamStateChanged=" + started + " bytes=" + audioCapture.bytes());
            }
        });
    }

    private static void log(RokidCxrController.Listener listener, String line) {
        listener.onLog(line);
    }
}
