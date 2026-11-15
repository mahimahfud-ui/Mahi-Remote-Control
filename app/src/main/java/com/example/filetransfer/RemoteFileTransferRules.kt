package com.example.filetransfer

/**
 * Bounds and naming rules shared by controller-side chunked file transfer.
 */
object RemoteFileTransferRules {
    const val MAX_FILE_BYTES: Long = 1024L * 1024L * 1024L
    const val CHUNK_BYTES: Int = 32 * 1024

    fun safeFileName(rawName: String): String? {
        val name = rawName.trim()
        if (name.isBlank() || name == "." || name == "..") return null
        if (name.contains('/') || name.contains('\\') || name.any { it.code == 0 || it.code < 0x20 }) return null
        val sanitized = name.replace(Regex("[:*?\"<>|]"), "_")
        if (sanitized.isBlank() || sanitized == "." || sanitized == ".." || sanitized.length > 180) return null
        return sanitized
    }

    fun isValidTransferId(transferId: String): Boolean =
        transferId.matches(Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"))

    fun chunkLength(totalBytes: Long, offset: Long): Int {
        require(totalBytes in 0..MAX_FILE_BYTES) { "File size exceeds the allowed transfer limit." }
        require(offset in 0..totalBytes) { "File chunk offset is outside the file." }
        return minOf(CHUNK_BYTES.toLong(), totalBytes - offset).toInt()
    }

    fun temporaryUploadPath(destinationPath: String, transferId: String): String {
        require(isValidTransferId(transferId)) { "Invalid transfer identifier." }
        require(destinationPath.isNotBlank()) { "Remote destination path is required." }
        return "$destinationPath.mahi-upload-$transferId.part"
    }
}
