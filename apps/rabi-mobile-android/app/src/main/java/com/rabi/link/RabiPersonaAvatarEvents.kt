package com.rabi.link

/** App-private broadcast contract for a single persona avatar change. */
object RabiPersonaAvatarEvents {
    const val ACTION_CHANGED = "com.rabi.link.persona.AVATAR_CHANGED"
    const val EXTRA_ROLE_ID = "role_id"
    const val EXTRA_AVATAR_VERSION = "avatar_version"
    const val EXTRA_AVATAR_URL = "avatar_url"
}
