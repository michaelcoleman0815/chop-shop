package app.cutalong.engine.example;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

/**
 * The test app's activity. Launched with the self-test flag
 * (adb shell am start -n app.cutalong.engine.example/.MainActivity --ez selftest true),
 * the page runs the self-test by itself and the screen stays on while it does.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SelfTestHostPlugin.class);
        SelfTestHostPlugin.selftest = getIntent().getBooleanExtra("selftest", false);
        super.onCreate(savedInstanceState);
        if (SelfTestHostPlugin.selftest) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
