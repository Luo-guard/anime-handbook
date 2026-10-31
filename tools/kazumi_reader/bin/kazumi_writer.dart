import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:hive_ce/hive.dart';
import 'kazumi_models.dart';

Future<void> main(List<String> args) async {
 if(args.length!=1) throw ArgumentError('writer requires database path');
 final file=File(args.first);
 if(!await file.exists()) throw StateError('Database missing');
 final input=jsonDecode(await stdin.transform(utf8.decoder).join()) as Map;
 Hive.init(file.parent.path);
 Hive.registerAdapter(BangumiItemAdapter());Hive.registerAdapter(CollectedBangumiAdapter());Hive.registerAdapter(BangumiTagAdapter());
 Box<CollectedBangumi>? box;
 try {
  box=await Hive.openBox<CollectedBangumi>('collectibles');
  final backup=File('${file.path}.handbook-${DateTime.now().microsecondsSinceEpoch}.bak');
  await file.copy(backup.path);
  final results=<Map<String,dynamic>>[];
  for(final job in input['jobs'] as List) {
   final id=job['anime_id'] as int;dynamic key;
   for(final k in box.keys) { if(box.get(k)!.bangumiItem.id==id){key=k;break;} }
   final current=key==null?null:box.get(key);
   final desired=job['status'] as int;
   if(input['policy']=='kazumi' && current?.type!=job['baseline'] && current?.type!=desired){
    results.add({'id':id,'status':current?.type});continue;
   }
   if(current!=null){await box.put(key,CollectedBangumi(current.bangumiItem,DateTime.now(),desired));}
   else {
    final d=jsonDecode(job['subject']) as Map;
    final r=(d['rating']??{}) as Map;
    final item=BangumiItem(id:id,type:2,name:d['name']??'',nameCn:d['name_cn']??'',summary:d['summary']??'',airDate:d['date']??'',airWeekday:0,rank:r['rank']??0,images:Map<String,String>.from(d['images']??{}),tags:[],alias:[],ratingScore:(r['score']??0).toDouble(),votes:r['total']??0,votesCount:[],info:'');
    if(box.containsKey(id)) throw StateError("Unexpected Hive key collision");
    await box.put(id,CollectedBangumi(item,DateTime.now(),desired));
   }
   await box.flush();
   results.add({'id':id,'status':desired});
  }
  await box.close();box=null;
  final check=await Hive.openBox<CollectedBangumi>('collectibles');
  try {
   for(final row in results){final found=check.values.where((v)=>v.bangumiItem.id==row['id']).toList();if((found.isEmpty?null:found.first.type)!=row['status'])throw StateError('Readback verification failed');}
  }finally{await check.close();}
  stdout.write(jsonEncode({'items':results}));
 }finally{await box?.close();}
}
