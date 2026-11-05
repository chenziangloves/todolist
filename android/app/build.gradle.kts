import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
}

// 本地与 CI 共用同一套签名配置：
// - 本地：android/keystore.properties（已被 .gitignore 排除）
// - CI  ：workflow 构建前用 GitHub Secrets 现场生成同名文件
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) {
        FileInputStream(keystorePropsFile).use { load(it) }
    }
}
val hasSigning = keystorePropsFile.exists()

// 版本号：CI 用 -PappVersionCode / -PappVersionName 传入，保证每次构建都比上一版大，
// 手机才能「覆盖安装」而不是要求卸载。本地构建用下面的默认值。
val appVersionCode = (rootProject.findProperty("appVersionCode") as String?)?.toIntOrNull() ?: 1
val appVersionName = (rootProject.findProperty("appVersionName") as String?) ?: "1.0.0"

android {
    namespace = "com.chenziang.todolist"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.chenziang.todolist"
        minSdk = 26
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        if (hasSigning) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            if (hasSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
}
