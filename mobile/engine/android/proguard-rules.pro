# libcutalong_engine.so finds these by name through JNI.
-keep class app.cutalong.engine.EngineNative { *; }
-keep interface app.cutalong.engine.EngineNative$Listener { *; }
-keep class * implements app.cutalong.engine.EngineNative$Listener { *; }
