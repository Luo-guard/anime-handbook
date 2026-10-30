package com.animehandbook.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.util.HashSet;
import java.util.Set;
import static org.junit.Assert.*;

public class RecordStateMergerTest {
  private JSONObject state() throws Exception {
    return new JSONObject("{\"format\":1,\"tables\":{\"anime\":[],\"events\":[],\"settings\":[],\"custom_collections\":[],\"custom_collection_items\":[],\"ranking_boards\":[],\"ranking_templates\":[],\"ranking_tiers\":[],\"ranking_items\":[]}}");
  }

  private JSONObject watch(long id, int anime, String time, String... episodes) throws Exception {
    JSONArray keys = new JSONArray(); for (String key : episodes) keys.put(key);
    return new JSONObject().put("id", id).put("anime_id", anime).put("event_type", "watch")
      .put("episodes", keys.toString()).put("created_at", time).put("content", "");
  }

  private void add(JSONObject state, JSONObject event) throws Exception {
    state.getJSONObject("tables").getJSONArray("events").put(event);
  }

  private JSONArray events(JSONObject state) throws Exception {
    return state.getJSONObject("tables").getJSONArray("events");
  }

  @Test public void earliestWatchWinsInBothDirectionsAcrossTimezones() throws Exception {
    JSONObject a = state(), b = state();
    add(a, watch(1, 1, "2026-09-15T10:00:00+08:00", "bgm:101"));
    add(b, watch(2, 1, "2026-09-15T03:00:00Z", "bgm:101"));
    for (JSONObject merged : new JSONObject[]{RecordStateMerger.merge(a, b), RecordStateMerger.merge(b, a)}) {
      assertEquals(1, events(merged).length());
      assertEquals("2026-09-15T10:00:00+08:00", events(merged).getJSONObject(0).getString("created_at"));
    }
  }

  @Test public void overlappingBatchesKeepOtherEpisodesAndOtherAnime() throws Exception {
    JSONObject a = state(), b = state();
    add(a, watch(1, 1, "2026-09-15T10:00:00+08:00", "bgm:101", "bgm:102"));
    add(b, watch(1, 1, "2026-09-15T01:00:00Z", "bgm:102", "bgm:103"));
    add(b, watch(2, 2, "2026-09-15T04:00:00Z", "bgm:101"));
    JSONObject merged = RecordStateMerger.merge(a, b);
    JSONArray result = events(merged);
    assertEquals(4, result.length()); Set<Long> ids = new HashSet<>();
    for (int i = 0; i < result.length(); i++) {
      JSONObject event = result.getJSONObject(i); ids.add(event.getLong("id"));
      JSONArray keys = new JSONArray(event.getString("episodes")); assertEquals(1, keys.length());
      if (event.getInt("anime_id") == 1 && "bgm:102".equals(keys.getString(0)))
        assertEquals("2026-09-15T01:00:00Z", event.getString("created_at"));
    }
    assertEquals(result.length(), ids.size());
    assertEquals(result.toString(), events(RecordStateMerger.merge(merged, b)).toString());
  }

  @Test public void localDuplicatesAlsoUseEarliestTime() throws Exception {
    JSONObject a = state();
    add(a, watch(1, 1, "2026-09-15T10:00:00+08:00", "bgm:101"));
    add(a, watch(2, 1, "2026-09-15T09:00:00+08:00", "bgm:101"));
    JSONArray result = events(RecordStateMerger.merge(a, state()));
    assertEquals(1, result.length()); assertEquals(2, result.getJSONObject(0).getLong("id"));
  }

  @Test public void notesWithCollidingDeviceIdsArePreservedAndRepeatedSyncDoesNotDuplicate() throws Exception {
    JSONObject a = state(), b = state();
    add(a, new JSONObject().put("id", 1).put("event_type", "note").put("anime_id", JSONObject.NULL).put("episodes", "[]").put("content", "desktop").put("created_at", "2026-09-15T10:00:00+08:00"));
    add(b, new JSONObject(events(a).getJSONObject(0).toString()).put("content", "mobile"));
    JSONObject merged = RecordStateMerger.merge(a, b);
    assertEquals(2, events(merged).length());
    assertNotEquals(events(merged).getJSONObject(0).getLong("id"), events(merged).getJSONObject(1).getLong("id"));
    assertEquals(events(merged).toString(), events(RecordStateMerger.merge(merged, b)).toString());
  }

  @Test public void watchedProgressIsUnionedAndMetadataUsesRealLatestTime() throws Exception {
    JSONObject a = state(), b = state();
    a.getJSONObject("tables").getJSONArray("anime").put(new JSONObject().put("id", 1).put("watched_episodes", "[\"bgm:101\"]").put("updated_at", "2026-09-15T10:00:00+08:00").put("name", "old"));
    b.getJSONObject("tables").getJSONArray("anime").put(new JSONObject().put("id", 1).put("watched_episodes", "[\"bgm:102\"]").put("updated_at", "2026-09-15T03:00:00Z").put("name", "new"));
    JSONObject anime = RecordStateMerger.merge(a, b).getJSONObject("tables").getJSONArray("anime").getJSONObject(0);
    assertEquals("new", anime.getString("name")); assertEquals("[\"bgm:101\",\"bgm:102\"]", anime.getString("watched_episodes"));
  }

  @Test public void naiveTimesUseBeijingAndInvalidTimeDoesNotWin() throws Exception {
    JSONObject a = state(), b = state();
    add(a, watch(1, 1, "2026-09-15T10:00:00", "bgm:101"));
    add(b, watch(2, 1, "2026-09-15T03:00:00Z", "bgm:101"));
    assertEquals(1, events(RecordStateMerger.merge(a, b)).getJSONObject(0).getLong("id"));
    b.getJSONObject("tables").put("events", new JSONArray().put(watch(2, 1, "invalid", "bgm:101")));
    assertEquals(1, events(RecordStateMerger.merge(b, a)).getJSONObject(0).getLong("id"));
  }

  @Test public void equalInstantsChooseSameRecordAndInputsAreNotMutated() throws Exception {
    JSONObject a = state(), b = state();
    add(a, watch(1, 1, "2026-09-15T10:00:00+08:00", "bgm:101"));
    add(b, watch(2, 1, "2026-09-15T02:00:00Z", "bgm:101"));
    String beforeA = a.toString(), beforeB = b.toString();
    assertEquals(events(RecordStateMerger.merge(a, b)).toString(), events(RecordStateMerger.merge(b, a)).toString());
    assertEquals(beforeA, a.toString()); assertEquals(beforeB, b.toString());
  }
}
