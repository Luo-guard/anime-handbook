package com.animehandbook.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/** Merge independent additions; one anime/episode keeps its earliest viewing. */
final class RecordStateMerger {
  private RecordStateMerger() {}

  private static JSONArray arrayValue(JSONObject row, String field) {
    JSONArray value = row.optJSONArray(field);
    if (value != null) return value;
    try { return new JSONArray(row.optString(field, "[]")); }
    catch (Exception ignored) { return new JSONArray(); }
  }

  private static Instant moment(JSONObject row, String field) {
    String raw = row.optString(field, "").replace(' ', 'T');
    try { return OffsetDateTime.parse(raw).toInstant(); }
    catch (Exception ignored) {
      try { return LocalDateTime.parse(raw).toInstant(ZoneOffset.ofHours(8)); }
      catch (Exception invalid) { return null; }
    }
  }

  private static String canonical(Object value) throws Exception {
    if (value == null || value == JSONObject.NULL) return "null";
    if (value instanceof JSONObject) {
      JSONObject row = (JSONObject)value;
      TreeSet<String> keys = new TreeSet<>(); row.keys().forEachRemaining(keys::add);
      List<String> parts = new ArrayList<>();
      for (String key : keys) parts.add(JSONObject.quote(key) + ":" + canonical(row.get(key)));
      return "{" + String.join(",", parts) + "}";
    }
    if (value instanceof JSONArray) {
      JSONArray array = (JSONArray)value; List<String> parts = new ArrayList<>();
      for (int i = 0; i < array.length(); i++) parts.add(canonical(array.get(i)));
      return "[" + String.join(",", parts) + "]";
    }
    return value instanceof String ? JSONObject.quote((String)value) : String.valueOf(value);
  }

  private static JSONObject select(JSONObject left, JSONObject right, String field, boolean earlier) throws Exception {
    Instant a = moment(left, field), b = moment(right, field);
    if (a == null && b != null) return right;
    if (b == null && a != null) return left;
    if (a != null && b != null && !a.equals(b))
      return (earlier ? b.isBefore(a) : b.isAfter(a)) ? right : left;
    JSONObject aRow = new JSONObject(left.toString()), bRow = new JSONObject(right.toString());
    aRow.remove("id"); bRow.remove("id");
    // Keep remapped local IDs when the incoming record is otherwise identical.
    return canonical(bRow).compareTo(canonical(aRow)) < 0 ? right : left;
  }

  private static String eventKey(JSONObject event) throws Exception {
    JSONObject identity = new JSONObject();
    identity.put("type", event.opt("event_type") == null ? JSONObject.NULL : event.opt("event_type"));
    identity.put("anime", event.opt("anime_id") == null ? JSONObject.NULL : event.opt("anime_id"));
    identity.put("episodes", event.opt("episodes") == null ? JSONObject.NULL : event.opt("episodes"));
    identity.put("content", event.opt("content") == null ? JSONObject.NULL : event.opt("content"));
    identity.put("created", event.opt("created_at") == null ? JSONObject.NULL : event.opt("created_at"));
    return "event:" + canonical(identity);
  }

  static JSONObject merge(JSONObject local, JSONObject remote) throws Exception {
    // Deep copies keep the pending local/remote snapshots intact if upload fails.
    JSONObject merged = new JSONObject(local.toString());
    JSONObject tables = merged.getJSONObject("tables");
    JSONObject remoteTables = new JSONObject(remote.toString()).getJSONObject("tables");
    Map<String, JSONObject> byAnime = new LinkedHashMap<>();
    for (JSONObject source : new JSONObject[]{tables, remoteTables}) {
      JSONArray anime = source.optJSONArray("anime");
      for (int i = 0; anime != null && i < anime.length(); i++) {
        JSONObject incoming = anime.getJSONObject(i);
        if (!incoming.has("id") || incoming.isNull("id")) continue;
        String key = String.valueOf(incoming.opt("id")); JSONObject current = byAnime.get(key);
        if (current == null) { byAnime.put(key, incoming); continue; }
        Set<String> watched = new TreeSet<>();
        for (JSONObject row : new JSONObject[]{current, incoming}) {
          JSONArray keys = arrayValue(row, "watched_episodes");
          for (int j = 0; j < keys.length(); j++) watched.add(String.valueOf(keys.get(j)));
        }
        JSONObject chosen = select(current, incoming, "updated_at", false);
        JSONArray progress = new JSONArray(); for (String episode : watched) progress.put(episode);
        chosen.put("watched_episodes", progress.toString()); byAnime.put(key, chosen);
      }
    }
    JSONArray anime = new JSONArray(); for (JSONObject row : byAnime.values()) anime.put(row);
    tables.put("anime", anime);

    Map<String, JSONObject> byEvent = new TreeMap<>();
    for (JSONObject source : new JSONObject[]{tables, remoteTables}) {
      JSONArray events = source.optJSONArray("events");
      for (int i = 0; events != null && i < events.length(); i++) {
        JSONObject event = events.getJSONObject(i);
        JSONArray episodes = arrayValue(event, "episodes");
        if ("watch".equals(event.optString("event_type")) && event.has("anime_id") && !event.isNull("anime_id") && episodes.length() > 0) {
          // Old desktop events may contain several episodes: resolve each one independently.
          for (int j = 0; j < episodes.length(); j++) {
            String episode = String.valueOf(episodes.get(j));
            JSONObject item = new JSONObject(event.toString());
            item.put("episodes", new JSONArray().put(episode).toString());
            String key = "watch:" + event.opt("anime_id") + ":" + episode;
            JSONObject current = byEvent.get(key);
            byEvent.put(key, current == null ? item : select(current, item, "created_at", true));
          }
        } else {
          String key = eventKey(event);
          if (!byEvent.containsKey(key)) byEvent.put(key, event);
        }
      }
    }
    List<JSONObject> events = new ArrayList<>(byEvent.values());
    Set<Long> used = new HashSet<>(); long nextId = 1;
    for (JSONObject event : events) nextId = Math.max(nextId, event.optLong("id", 0) + 1);
    for (JSONObject event : events) {
      long id = event.optLong("id", 0);
      if (id <= 0 || used.contains(id)) { id = nextId++; event.put("id", id); }
      used.add(id);
    }
    events.sort(Comparator.comparingLong(row -> row.optLong("id")));
    JSONArray result = new JSONArray(); for (JSONObject row : events) result.put(row);
    tables.put("events", result);
    merged.put("exported_at", OffsetDateTime.now().toString());
    return merged;
  }
}
