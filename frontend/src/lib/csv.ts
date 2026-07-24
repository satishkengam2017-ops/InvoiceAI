// CSV export helpers. Excel/Google Sheets-friendly: UTF-8 BOM, CRLF rows,
// RFC 4180 quoting. On web the file downloads directly; on native it opens
// the share sheet (Save to Files / Drive / mail, etc.).
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";
import * as Sharing from "expo-sharing";

function escapeField(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [header, ...rows].map((row) => row.map(escapeField).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export async function downloadCsv(fileName: string, csv: string): Promise<void> {
  if (Platform.OS === "web") {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return;
  }
  const path = `${FileSystem.cacheDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(path, csv, { encoding: FileSystem.EncodingType.UTF8 });
  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(path, { mimeType: "text/csv", dialogTitle: `Save ${fileName}` });
  }
}

/** Today's date as YYYY-MM-DD for export file names. */
export function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
