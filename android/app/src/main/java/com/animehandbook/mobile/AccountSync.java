package com.animehandbook.mobile;

import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Local baseline and conditional uploads; never adds fields to the cloud document. */
final class AccountSync {
  static final class Snapshot {
    final int code; final String value, etag, modified;
    Snapshot(int code, String value, String etag) {this(code,value,etag,"");}
    Snapshot(int code, String value, String etag, String modified) {this.code=code;this.value=value;this.etag=etag==null?"":etag;this.modified=modified==null?"":modified;}
  }
  interface Remote {Snapshot probe() throws Exception; Snapshot get() throws Exception; Snapshot put(String state, String etag, String modified, boolean missing) throws Exception;}
  interface Store {
    String read() throws Exception;
    String baseline() throws Exception;
    boolean accept(String expected, String incoming) throws Exception;
    void checkpoint(String state, String etag) throws Exception;
  }
  static String digest(String raw) throws Exception {
    JSONObject state=new JSONObject(raw);state.remove("exported_at");
    return hash(RecordStateMerger.canonical(state));
  }
  private static String hash(String raw) throws Exception {
    byte[] bytes=MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8));
    StringBuilder result=new StringBuilder();for(byte b:bytes)result.append(String.format("%02x",b));return result.toString();
  }
  private static boolean matches(String known, String raw) throws Exception {
    JSONObject old=new JSONObject(raw);old.remove("exported_at");
    return known.equals(digest(raw))||known.equals(hash(raw))||known.equals(hash(old.toString()));
  }
  /** WebDAV 的版本标识不一定要带引号：坚果云返回的就是不带引号的裸串，必须原样回传。
      弱校验器（W/…）按 RFC 不能用于 If-Match，只能退回 If-Unmodified-Since。 */
  static boolean usableVersion(String etag) {
    return etag!=null&&!etag.isEmpty()&&!etag.startsWith("W/");
  }
  static void requireVersion(String etag, String modified, boolean missing) throws Exception {
    if(missing||usableVersion(etag)||(modified!=null&&!modified.isEmpty()))return;
    throw new java.io.IOException("云端没有返回可用的版本号，为避免覆盖其它设备的数据，本次未上传；请检查同步地址后重试");
  }
  private static boolean hasRecords(String raw) throws Exception {
    JSONObject tables=new JSONObject(raw).getJSONObject("tables");
    for(String key:new String[]{"anime","events"})if(tables.optJSONArray(key)!=null&&tables.optJSONArray(key).length()>0)return true;
    return false;
  }
  static JSONObject run(Store store, Remote remote, String known, String previousEtag, String resolution) throws Exception {
    String local=store.read();new JSONObject(local).getJSONObject("tables");
    Snapshot probe=remote.probe();
    if(probe.code!=200&&probe.code!=404&&probe.code!=405)throw new java.io.IOException("读取云端失败（HTTP "+probe.code+"）");
    if(probe.code==404)return upload(store,remote,local,"","",true);
    boolean localUnchanged=!known.isEmpty()&&matches(known,local);
    if(probe.code==200&&!previousEtag.isEmpty()&&previousEtag.equals(probe.etag)&&!known.isEmpty()&&resolution.isEmpty()) {
      if(!localUnchanged)return upload(store,remote,local,probe.etag,probe.modified,false);
      store.checkpoint(local,probe.etag);return new JSONObject().put("action","unchanged").put("message","两边数据已经是最新");
    }
    Snapshot incoming=remote.get();
    if(incoming.code==404)return upload(store,remote,local,"","",true);
    if(incoming.code!=200)throw new java.io.IOException("读取云端失败（HTTP "+incoming.code+"）");
    String value=new JSONObject(incoming.value).getJSONObject("state").toString();new JSONObject(value).getJSONObject("tables");
    if(digest(local).equals(digest(value))){store.checkpoint(local,incoming.etag);return new JSONObject().put("action","unchanged").put("message","两边数据已经是最新");}
    if("local".equals(resolution))return upload(store,remote,local,incoming.etag,incoming.modified,false);
    boolean remoteUnchanged=!known.isEmpty()&&matches(known,value);
    if("remote".equals(resolution)||localUnchanged||(known.isEmpty()&&!hasRecords(local)))return download(store,local,value,incoming.etag,"downloaded");
    if(remoteUnchanged)return upload(store,remote,local,incoming.etag,incoming.modified,false);
    String base=store.baseline();
    if(base==null||known.isEmpty()||!matches(known,base))return new JSONObject().put("conflict",true);
    String merged=RecordStateMerger.merge(new JSONObject(local),new JSONObject(value),new JSONObject(base)).toString();
    requireVersion(incoming.etag,incoming.modified,false);
    Snapshot uploaded=remote.put(merged,incoming.etag,incoming.modified,false);
    return download(store,local,merged,uploaded.etag,"merged");
  }
  private static JSONObject upload(Store store,Remote remote,String local,String etag,String modified,boolean missing)throws Exception{
    requireVersion(etag,modified,missing);Snapshot uploaded=remote.put(local,etag,modified,missing);store.checkpoint(local,uploaded.etag);
    return new JSONObject().put("action","uploaded").put("message","已上传手机端最新数据");
  }
  private static JSONObject download(Store store,String local,String incoming,String etag,String action)throws Exception{
    boolean accepted=store.accept(local,incoming);
    if(accepted)store.checkpoint(incoming,etag);
    JSONObject result=new JSONObject().put("action",action).put("message",action.equals("merged")?"已合并两边的观看记录与进度":"已下载云端最新数据");
    if(accepted)result.put("state",new JSONObject(incoming));else result.put("pendingLocal",true);
    return result;
  }
}
