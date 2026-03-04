export interface LogLine {
  text: string;
  stream: 'stdout' | 'stderr';
}

/**
 * Parse a Docker multiplexed stream chunk.
 *
 * Docker uses an 8-byte header per frame when the container is NOT TTY:
 *   - byte 0: stream type (1 = stdout, 2 = stderr)
 *   - bytes 1-3: padding (zeroes)
 *   - bytes 4-7: uint32 big-endian payload size
 *
 * Returns parsed lines and any leftover bytes (incomplete frame at end of chunk).
 */
export function parseMuxedChunk(buffer: Buffer): { lines: LogLine[]; remainder: Buffer } {
  const lines: LogLine[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const payloadSize = buffer.readUInt32BE(offset + 4);

    if (offset + 8 + payloadSize > buffer.length) {
      // Incomplete frame - return remainder for next chunk
      break;
    }

    const payload = buffer.subarray(offset + 8, offset + 8 + payloadSize).toString('utf-8');
    const stream: 'stdout' | 'stderr' = streamType === 2 ? 'stderr' : 'stdout';

    // Split payload by newlines (single frame can contain multiple lines)
    const rawLines = payload.split('\n');
    for (const line of rawLines) {
      if (line.length > 0) {
        lines.push({ text: line, stream });
      }
    }

    offset += 8 + payloadSize;
  }

  const remainder = offset < buffer.length ? buffer.subarray(offset) : Buffer.alloc(0);
  return { lines, remainder };
}

/**
 * Parse a TTY (non-multiplexed) chunk into log lines.
 * TTY containers send raw text without the 8-byte headers.
 */
export function parseTtyChunk(chunk: string): LogLine[] {
  const lines: LogLine[] = [];
  const rawLines = chunk.split('\n');
  for (const line of rawLines) {
    if (line.length > 0) {
      lines.push({ text: line, stream: 'stdout' });
    }
  }
  return lines;
}
