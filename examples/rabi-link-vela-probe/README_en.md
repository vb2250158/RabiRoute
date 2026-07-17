<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi Link vela probe

> Status: historical hardware capability probe. It can build a debug `.rpk`, but it is not the current RabiLink AIUI path and does not prove access to third-party health history.

This quick-app project runs on Xiaomi vela wearables. It is not an Android APK. It was built as a companion probe for the `com.rabi.link` phone application to test whether wearable-side capabilities such as `interconnect` could bridge back to the same package on Android.

The probe covers device information, battery status, a system-event placeholder, and the wearable-to-phone `interconnect` bridge.

No public base-capability API was found for third-party quick apps to read historical heart-rate or sleep data. `interconnect` only transports messages; it is not a health-data API.

## Build

```bash
npm install
npm run build
```

The expected output is `dist/com.rabi.link.debug.0.1.0.rpk`. Use AIoT-IDE with the `watch` simulator. Real-device installation depends on firmware, account permissions, and Xiaomi's permitted test environment.

The build has been verified. The vela and Android packages share `com.rabi.link`; a real `interconnect` test also requires a compatible signing setup.
