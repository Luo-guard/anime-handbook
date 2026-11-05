package com.animehandbook.mobile;

import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.Test;
import static org.junit.Assert.*;

public class AccountSyncTest {
  private String state(String keys) throws Exception {
    return new JSONObject().put("tables", new JSONObject().put("anime",new JSONArray().put(new JSONObject().put("id",1).put("watched_episodes",keys)))
      .put("events",new JSONArray()).put("settings",new JSONArray())).toString();
  }
  private static class Store implements AccountSync.Store {
    String local, base, checkpoint, version; boolean accept=true;
    Store(String local,String base){this.local=local;this.base=base;}
    public String read(){return local;}
    public String baseline(){return base;}
    public boolean accept(String expected,String incoming){if(!accept||!local.equals(expected))return false;local=incoming;return true;}
    public void checkpoint(String value,String etag){checkpoint=value;version=etag;base=value;}
  }
  private static class Remote implements AccountSync.Remote {
    int heads,gets,puts;String state,received,expected,headVersion="\"head\"",getVersion="\"get\"";boolean missing,fail;
    Remote(String state){this.state=state;}
    public AccountSync.Snapshot probe(){heads++;return new AccountSync.Snapshot(missing?404:200,null,headVersion);}
    public AccountSync.Snapshot get()throws Exception{gets++;return new AccountSync.Snapshot(200,new JSONObject().put("state",new JSONObject(state)).toString(),getVersion);}
    public AccountSync.Snapshot put(String value,String etag,boolean absent)throws Exception{puts++;expected=etag;assertEquals(missing,absent);if(fail)throw new java.io.IOException("HTTP 412");received=value;return new AccountSync.Snapshot(204,null,"\"new\"");}
  }
  @Test public void cancellationWinsAndIndependentAdditionsSurvive()throws Exception{
    String base=state("[\"01\",\"02\"]"),local=state("[\"01\"]"),other=state("[\"01\",\"02\",\"03\"]");
    JSONObject b=new JSONObject(base);b.getJSONObject("tables").getJSONArray("events").put(new JSONObject().put("id",1).put("event_type","watch").put("anime_id",1).put("episodes","[\"01\",\"02\"]"));
    JSONObject r=new JSONObject(other);r.getJSONObject("tables").put("events",b.getJSONObject("tables").getJSONArray("events"));
    for(JSONObject merged:new JSONObject[]{RecordStateMerger.merge(new JSONObject(local),r,b),RecordStateMerger.merge(r,new JSONObject(local),b)}){
      assertEquals("[\"01\",\"03\"]",merged.getJSONObject("tables").getJSONArray("anime").getJSONObject(0).getString("watched_episodes"));
      assertEquals("[\"01\"]",merged.getJSONObject("tables").getJSONArray("events").getJSONObject(0).getString("episodes"));
    }
  }
  @Test public void mergeUsesGetVersionNotEarlierHeadAndAddsNoRequests()throws Exception{
    String base=state("[\"01\",\"02\"]");Store store=new Store(state("[\"01\"]"),base);Remote remote=new Remote(state("[\"01\",\"02\",\"03\"]"));
    JSONObject result=AccountSync.run(store,remote,AccountSync.digest(base),"\"old\"","");
    assertEquals("merged",result.getString("action"));assertEquals(remote.getVersion,remote.expected);
    assertEquals(1,remote.heads);assertEquals(1,remote.gets);assertEquals(1,remote.puts);
    assertEquals("[\"01\",\"03\"]",new JSONObject(remote.received).getJSONObject("tables").getJSONArray("anime").getJSONObject(0).getString("watched_episodes"));
  }
  @Test public void changedDuringDownloadKeepsLocalAndOldBaseline()throws Exception{
    String base=state("[\"01\"]");Store store=new Store(base,base);store.accept=false;Remote remote=new Remote(state("[\"01\",\"02\"]"));
    JSONObject result=AccountSync.run(store,remote,AccountSync.digest(base),"\"old\"","");
    assertTrue(result.getBoolean("pendingLocal"));assertFalse(result.has("state"));assertNull(store.checkpoint);assertEquals(base,store.local);
  }
  @Test public void rejectedUploadNeverAdvancesBaseline()throws Exception{
    String base=state("[\"01\"]");Store store=new Store(state("[\"01\",\"02\"]"),base);Remote remote=new Remote(base);remote.fail=true;
    try{AccountSync.run(store,remote,AccountSync.digest(base),remote.headVersion,"");fail();}catch(java.io.IOException expected){}
    assertNull(store.checkpoint);assertEquals(0,remote.gets);assertEquals(1,remote.puts);
  }
  @Test public void missingBaselineRequiresChoiceWithoutUpload()throws Exception{
    Store store=new Store(state("[\"02\"]"),null);Remote remote=new Remote(state("[\"03\"]"));
    assertTrue(AccountSync.run(store,remote,AccountSync.digest(state("[\"01\"]")),"","").getBoolean("conflict"));assertEquals(0,remote.puts);
  }
  @Test public void unchangedSeedsDeviceOnlyBaselineAndDoesNotDownload()throws Exception{
    String base=state("[\"01\"]");Store store=new Store(base,null);Remote remote=new Remote(base);
    assertEquals("unchanged",AccountSync.run(store,remote,AccountSync.digest(base),remote.headVersion,"").getString("action"));
    assertEquals(0,remote.gets);assertEquals(0,remote.puts);assertEquals(base,store.checkpoint);
  }
  @Test public void weakOrMissingVersionCannotOverwriteButCreateIsConditional()throws Exception{
    for(String etag:new String[]{"","W/\"weak\""}){try{AccountSync.requireVersion(etag,false);fail();}catch(java.io.IOException expected){}}
    String local=state("[]");Store store=new Store(local,null);Remote remote=new Remote(local);remote.missing=true;
    AccountSync.run(store,remote,"","","");assertEquals(1,remote.puts);assertEquals(0,remote.gets);
  }
  @Test public void digestIgnoresKeyOrderingAndExportTimestamp()throws Exception{
    assertEquals(AccountSync.digest("{\"tables\":{},\"exported_at\":\"a\",\"format\":1}"),AccountSync.digest("{\"format\":1,\"tables\":{},\"exported_at\":\"b\"}"));
  }
}
