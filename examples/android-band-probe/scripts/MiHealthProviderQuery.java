import android.database.Cursor;
import android.content.ContentResolver;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import android.content.AttributionSource;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Arrays;

public class MiHealthProviderQuery {
    public static void main(String[] args) {
        try {
            run(args);
        } catch (Throwable throwable) {
            throwable.printStackTrace(System.err);
            System.exit(1);
        }
        System.out.flush();
        System.err.flush();
        System.exit(0);
    }

    private static void run(String[] args) throws Exception {
        if (args.length < 1) {
            throw new IllegalArgumentException("usage: MiHealthProviderQuery <uri> [projectionCsv|-] [selection|-] [selectionArgCsv|-] [sort|-]");
        }

        Looper.prepareMainLooper();

        String uriText = args[0];
        Uri uri = Uri.parse(uriText);
        String authority = uri.getAuthority();
        String[] projection = args.length > 1 && !"-".equals(args[1]) ? args[1].split(",") : null;
        String selection = args.length > 2 && !"-".equals(args[2]) ? args[2] : null;
        String[] selectionArgs = args.length > 3 && !"-".equals(args[3]) ? args[3].split(",") : null;
        String sort = args.length > 4 && !"-".equals(args[4]) ? args[4] : null;

        Object activityManager = Class.forName("android.app.ActivityManager")
                .getMethod("getService")
                .invoke(null);
        IBinder token = new Binder();
        Object holder = acquireProvider(activityManager, authority, token);
        if (holder == null) {
            throw new IllegalStateException("找不到 Provider: " + authority);
        }

        Object provider = readField(holder, "provider");
        try {
            Cursor cursor = query(provider, uri, projection, selection, selectionArgs, sort);
            printCursor(cursor);
        } finally {
            releaseProvider(activityManager, authority, token);
        }
    }

    private static Object acquireProvider(Object activityManager, String authority, IBinder token) throws Exception {
        for (Method method : activityManager.getClass().getMethods()) {
            if (!"getContentProviderExternal".equals(method.getName())) {
                continue;
            }
            Class<?>[] types = method.getParameterTypes();
            if (types.length == 4) {
                return method.invoke(activityManager, authority, 0, token, "MiHealthProviderQuery");
            }
            if (types.length == 3) {
                return method.invoke(activityManager, authority, 0, token);
            }
        }
        throw new NoSuchMethodException("getContentProviderExternal");
    }

    private static void releaseProvider(Object activityManager, String authority, IBinder token) {
        for (Method method : activityManager.getClass().getMethods()) {
            if (!"removeContentProviderExternal".equals(method.getName())) {
                continue;
            }
            try {
                Class<?>[] types = method.getParameterTypes();
                if (types.length == 2) {
                    method.invoke(activityManager, authority, token);
                    return;
                }
                if (types.length == 3) {
                    method.invoke(activityManager, authority, token, "MiHealthProviderQuery");
                    return;
                }
            } catch (Throwable ignored) {
            }
        }
    }

    private static Cursor query(Object provider, Uri uri, String[] projection, String selection, String[] selectionArgs, String sort) throws Exception {
        Method legacy = null;
        Method bundleQuery = null;
        for (Method method : provider.getClass().getMethods()) {
            if (!"query".equals(method.getName())) {
                continue;
            }
            Class<?>[] types = method.getParameterTypes();
            if (types.length == 7 && types[1] == Uri.class && types[2].isArray()) {
                legacy = method;
            }
            if (types.length == 5 && types[1] == Uri.class && types[3] == Bundle.class) {
                bundleQuery = method;
            }
        }

        if (legacy != null) {
            return (Cursor) legacy.invoke(provider, shellAttribution(), uri, projection, selection, selectionArgs, sort, null);
        }

        if (bundleQuery != null) {
            Bundle bundle = new Bundle();
            if (selection != null) {
                bundle.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection);
            }
            if (selectionArgs != null) {
                bundle.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, selectionArgs);
            }
            if (sort != null) {
                bundle.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, sort);
            }
            return (Cursor) bundleQuery.invoke(provider, shellAttribution(), uri, projection, bundle, null);
        }

        throw new NoSuchMethodException("query methods: " + Arrays.toString(provider.getClass().getMethods()));
    }

    private static AttributionSource shellAttribution() {
        return new AttributionSource.Builder(2000)
                .setPackageName("com.android.shell")
                .build();
    }

    private static void printCursor(Cursor cursor) {
        if (cursor == null) {
            System.out.println("cursor=null");
            return;
        }

        try {
            String[] columns = cursor.getColumnNames();
            System.out.println("columns=" + String.join(",", columns));
            int row = 0;
            while (cursor.moveToNext()) {
                StringBuilder line = new StringBuilder();
                line.append("Row: ").append(row).append(' ');
                for (int i = 0; i < columns.length; i++) {
                    if (i > 0) {
                        line.append(", ");
                    }
                    line.append(columns[i]).append('=');
                    if (cursor.isNull(i)) {
                        line.append("null");
                    } else {
                        line.append(cursor.getString(i));
                    }
                }
                System.out.println(line);
                row++;
            }
            if (row == 0) {
                System.out.println("No result found.");
            }
        } finally {
            cursor.close();
        }
    }

    private static Object readField(Object target, String fieldName) throws Exception {
        Field field = target.getClass().getField(fieldName);
        return field.get(target);
    }
}
