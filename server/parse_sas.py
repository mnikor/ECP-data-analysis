#!/usr/bin/env python3
import json
import os
import sys

try:
    import pyreadstat
except ImportError as exc:
    print(
        json.dumps(
            {
                "error": (
                    "Python dependency 'pyreadstat' is not installed on the server. "
                    "Install requirements before importing SAS transport files."
                )
            }
        )
    )
    sys.exit(1)


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Path to SAS dataset is required."}))
        return 1

    file_path = sys.argv[1]
    extension = os.path.splitext(file_path)[1].lower()

    try:
        if extension == ".xpt":
            frame, meta = pyreadstat.read_xport(file_path)
            format_label = "XPT"
        elif extension == ".sas7bdat":
            frame, meta = pyreadstat.read_sas7bdat(file_path)
            format_label = "SAS7BDAT"
        else:
            print(json.dumps({"error": f"Unsupported SAS dataset format: {extension}"}))
            return 1

        frame.columns = [str(column) for column in frame.columns]
        csv_content = frame.to_csv(index=False)
        payload = {
            "csvContent": csv_content,
            "rowCount": int(len(frame.index)),
            "columnCount": int(len(frame.columns)),
            "columns": [str(column) for column in frame.columns],
            "format": format_label,
            "tableName": getattr(meta, "table_name", "") or "",
            "fileLabel": getattr(meta, "file_label", "") or "",
        }
        print(json.dumps(payload))
        return 0
    except Exception as exc:  # pragma: no cover - runtime parser errors depend on input files
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
