package com.rabi.link.modules.rokid;

final class RokidCxrLinkState {
    private boolean cxrConnected;
    private boolean glassBtConnected;
    private boolean customViewOpened;

    synchronized void setCxrConnected(boolean connected) {
        cxrConnected = connected;
        if (!connected) {
            customViewOpened = false;
        }
    }

    synchronized void setGlassBtConnected(boolean connected) {
        glassBtConnected = connected;
        if (!connected) {
            customViewOpened = false;
        }
    }

    synchronized void setCustomViewOpened(boolean opened) {
        customViewOpened = opened;
    }

    synchronized boolean isCxrConnected() {
        return cxrConnected;
    }

    synchronized boolean isGlassBtConnected() {
        return glassBtConnected;
    }

    synchronized boolean isLinkReady() {
        return cxrConnected && glassBtConnected;
    }

    synchronized boolean isCustomViewOpened() {
        return customViewOpened;
    }

    synchronized void reset() {
        cxrConnected = false;
        glassBtConnected = false;
        customViewOpened = false;
    }

    synchronized String summary() {
        return "cxr=" + cxrConnected + " bt=" + glassBtConnected + " customView=" + customViewOpened;
    }
}
