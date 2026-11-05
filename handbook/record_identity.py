"""Explicit, user-confirmed record identity repairs shared through snapshots."""
import json

ALIAS_SETTING = "record_identity_aliases"

def read_aliases(*settings_lists):
    aliases = {}
    for rows in settings_lists:
        for row in rows:
            if row.get("key") != ALIAS_SETTING:
                continue
            try:
                values = json.loads(row.get("value") or "{}")
            except (ValueError, TypeError):
                continue
            if not isinstance(values, dict):
                continue
            for old, target in values.items():
                if isinstance(old, str) and isinstance(target, str) and old and target and old != target:
                    aliases[old] = min(aliases.get(old, target), target)
    return aliases

def canonical_uid(uid, aliases):
    seen = set()
    while uid in aliases:
        if uid in seen:
            return min(seen)
        seen.add(uid)
        uid = aliases[uid]
    return uid

def store_aliases(rows, aliases):
    return [dict(row) for row in rows if row.get("key") != ALIAS_SETTING] + (
        [{"key": ALIAS_SETTING, "value": json.dumps(aliases, sort_keys=True)}] if aliases else [])

def collapse_repaired(rows, aliases):
    """Collapse only identities explicitly included in an approved repair."""
    from datetime import datetime, timezone, timedelta
    targets = {canonical_uid(uid, aliases) for uid in aliases}
    kept, positions = [], {}
    def rank(row):
        try:
            moment = datetime.fromisoformat(str(row.get("updated_at") or row.get("created_at") or "").replace("Z", "+00:00"))
            if moment.tzinfo is None:
                moment = moment.replace(tzinfo=timezone(timedelta(hours=8)))
            stamp = moment.timestamp()
        except (ValueError, TypeError, OverflowError):
            stamp = float("-inf")
        return stamp, json.dumps(row, sort_keys=True)
    for raw in rows:
        row = dict(raw)
        uid = canonical_uid(row.get("record_uid"), aliases)
        if uid not in targets or row.get("event_type") == "watch":
            kept.append(row)
            continue
        row["record_uid"] = uid
        if uid in positions:
            index = positions[uid]
            kept[index] = max((kept[index], row), key=rank)
        else:
            positions[uid] = len(kept)
            kept.append(row)
    return kept
