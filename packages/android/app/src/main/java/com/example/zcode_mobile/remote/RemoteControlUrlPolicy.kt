package com.example.zcode_mobile.remote

import android.net.Uri
import com.example.zcode_mobile.BuildConfig

private const val ZCODE_REMOTE_SCHEME = "zcode"
private const val ZCODE_REMOTE_HOST = "remote"

object RemoteControlUrlPolicy {
    fun resolve(raw: String?): String? {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) {
            return null
        }

        val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return null
        return resolve(uri)
    }

    fun resolve(uri: Uri?): String? {
        if (uri == null) {
            return null
        }

        if (uri.scheme == ZCODE_REMOTE_SCHEME && uri.host == ZCODE_REMOTE_HOST) {
            return buildDefaultRemoteUrl(uri)
        }

        if (isAllowedRemoteUrl(uri)) {
            return uri.toString()
        }

        return null
    }

    fun isAllowedRemoteUrl(raw: String?): Boolean {
        val uri = runCatching { Uri.parse(raw?.trim().orEmpty()) }.getOrNull() ?: return false
        return isAllowedRemoteUrl(uri)
    }

    private fun buildDefaultRemoteUrl(uri: Uri): String? {
        val configured = BuildConfig.REMOTE_CONTROL_DEFAULT_URL.trim()
        if (configured.isEmpty()) return null
        val configuredUri = runCatching { Uri.parse(configured) }.getOrNull() ?: return null
        if (configuredUri.scheme != "https" || !isAllowedRemoteUrl(configuredUri)) return null
        val base = configuredUri.buildUpon()
        uri.encodedQuery?.let { base.encodedQuery(it) }
        uri.encodedFragment?.let { base.encodedFragment(it) }
        return base.build().toString()
    }

    private fun isAllowedRemoteUrl(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase().orEmpty()
        val path = uri.path.orEmpty()

        if (host.isEmpty() || uri.userInfo != null || (path != "/remote" && !path.startsWith("/remote/"))) {
            return false
        }
        // 用户显式输入的 HTTPS 地址属于自己的远控服务，外壳不依赖官方域名。
        if (scheme == "https") {
            return true
        }

        if (!BuildConfig.DEBUG) {
            return false
        }

        // Bugfix: 开发机真机调试时二维码会指向局域网 Vite 地址。
        // debug 包额外放开本机和局域网 HTTP；仍只用于 /remote 路径。
        return (scheme == "http" || scheme == "https") && isDebugHost(host)
    }

    private fun isDebugHost(host: String): Boolean {
        if (host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2") {
            return true
        }
        if (host.endsWith(".local")) {
            return true
        }
        if (host.startsWith("192.168.") || host.startsWith("10.")) {
            return true
        }
        return Regex("^172\\.(1[6-9]|2\\d|3[0-1])\\.").containsMatchIn(host)
    }
}
