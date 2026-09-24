package com.rabi.link.modules.rokid;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.widget.*;
import com.rabi.link.RabiMobileUi;

/** User-started foreground diagnostic; leaving this Activity releases BLE resources. */
public final class RokidBlePingActivity extends Activity {
    private static final int PERMISSION_REQUEST = 7613;
    private RokidBlePingServer server;
    private TextView state;
    private boolean resumed;
    private boolean permissionPending;
    private boolean permissionAsked;

    @Override protected void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int padding = RabiMobileUi.dp(this, 20);
        root.setPadding(padding, padding, padding, padding);
        root.setBackgroundColor(RabiMobileUi.backgroundColor());
        root.addView(RabiMobileUi.hero(this, "眼镜 BLE 连通测试", "进入页面自动广播。眼镜测试页自动扫描并交换一次 ping / pong，离开即停止。"));
        state = new TextView(this);
        RabiMobileUi.styleNoteText(this, state);
        state.setText("尚未开始");
        root.addView(state);
        Button start = new Button(this);
        start.setText("重试 BLE 测试");
        RabiMobileUi.stylePrimaryButton(this, start);
        start.setOnClickListener(view -> { permissionAsked = false; start(); });
        root.addView(start);
        Button stop = new Button(this);
        stop.setText("停止测试");
        RabiMobileUi.styleSecondaryButton(this, stop);
        stop.setOnClickListener(view -> stop());
        root.addView(stop);
        setContentView(root);
        server = new RokidBlePingServer(this, text -> state.setText(text));
    }

    private void start() {
        if (!resumed) return;
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) != PackageManager.PERMISSION_GRANTED) {
            if (!permissionPending && !permissionAsked) {
                permissionPending = true;
                permissionAsked = true;
                requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE}, PERMISSION_REQUEST);
            }
            return;
        }
        server.start();
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != PERMISSION_REQUEST) return;
        permissionPending = false;
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED) start();
        else state.setText("需要附近设备权限才能广播；未启动测试");
    }

    private void stop() { if (server != null) server.close(); state.setText("BLE 测试已停止"); }
    @Override protected void onResume() { super.onResume(); resumed = true; start(); }
    @Override protected void onPause() { resumed = false; stop(); super.onPause(); }
    @Override protected void onDestroy() { if (server != null) server.close(); super.onDestroy(); }
}
