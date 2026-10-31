import 'package:hive_ce/hive.dart';

class BangumiTag {
  BangumiTag(this.name, this.count, this.totalCount);
  final String name;
  final int count;
  final int totalCount;
}

class BangumiItem {
  BangumiItem({
    required this.id,
    required this.type,
    required this.name,
    required this.nameCn,
    required this.summary,
    required this.airDate,
    required this.airWeekday,
    required this.rank,
    required this.images,
    required this.tags,
    required this.alias,
    required this.ratingScore,
    required this.votes,
    required this.votesCount,
    required this.info,
  });

  final int id;
  final int type;
  final String name;
  final String nameCn;
  final String summary;
  final String airDate;
  final int airWeekday;
  final int rank;
  final Map<String, String> images;
  final List<BangumiTag> tags;
  final List<String> alias;
  final double ratingScore;
  final int votes;
  final List<int> votesCount;
  final String info;
}

class CollectedBangumi {
  CollectedBangumi(this.bangumiItem, this.time, this.type);
  final BangumiItem bangumiItem;
  final DateTime time;
  final int type;
}

class BangumiItemAdapter extends TypeAdapter<BangumiItem> {
  @override
  final typeId = 0;

  @override
  BangumiItem read(BinaryReader reader) {
    final count = reader.readByte();
    if (count > 15) throw StateError("Unsupported Hive schema");
    final fields = <int, dynamic>{
      for (var i = 0; i < count; i++) reader.readByte(): reader.read(),
    };
    return BangumiItem(
      id: (fields[0] as num).toInt(),
      type: (fields[1] as num).toInt(),
      name: fields[2] as String,
      nameCn: fields[3] as String,
      summary: fields[4] as String,
      airDate: fields[5] as String,
      airWeekday: (fields[6] as num).toInt(),
      rank: (fields[7] as num).toInt(),
      images: (fields[8] as Map).cast<String, String>(),
      tags: fields[9] == null ? [] : (fields[9] as List).cast<BangumiTag>(),
      alias: fields[10] == null ? [] : (fields[10] as List).cast<String>(),
      ratingScore:
          fields[11] == null ? 0 : (fields[11] as num).toDouble(),
      votes: fields[12] == null ? 0 : (fields[12] as num).toInt(),
      votesCount:
          fields[13] == null ? [] : (fields[13] as List).cast<int>(),
      info: fields[14] == null ? '' : fields[14] as String,
    );
  }

  @override
  void write(BinaryWriter writer, BangumiItem obj) { writer.writeByte(15);writer.writeByte(0);writer.write(obj.id);writer.writeByte(1);writer.write(obj.type);writer.writeByte(2);writer.write(obj.name);writer.writeByte(3);writer.write(obj.nameCn);writer.writeByte(4);writer.write(obj.summary);writer.writeByte(5);writer.write(obj.airDate);writer.writeByte(6);writer.write(obj.airWeekday);writer.writeByte(7);writer.write(obj.rank);writer.writeByte(8);writer.write(obj.images);writer.writeByte(9);writer.write(obj.tags);writer.writeByte(10);writer.write(obj.alias);writer.writeByte(11);writer.write(obj.ratingScore);writer.writeByte(12);writer.write(obj.votes);writer.writeByte(13);writer.write(obj.votesCount);writer.writeByte(14);writer.write(obj.info);}
}

class CollectedBangumiAdapter extends TypeAdapter<CollectedBangumi> {
  @override
  final typeId = 3;

  @override
  CollectedBangumi read(BinaryReader reader) {
    final count = reader.readByte();
    if (count > 3) throw StateError("Unsupported Hive schema");
    final fields = <int, dynamic>{
      for (var i = 0; i < count; i++) reader.readByte(): reader.read(),
    };
    return CollectedBangumi(
      fields[0] as BangumiItem,
      fields[1] as DateTime,
      (fields[2] as num).toInt(),
    );
  }

  @override
  void write(BinaryWriter writer, CollectedBangumi obj) { writer.writeByte(3);writer.writeByte(0);writer.write(obj.bangumiItem);writer.writeByte(1);writer.write(obj.time);writer.writeByte(2);writer.write(obj.type);}
}

class BangumiTagAdapter extends TypeAdapter<BangumiTag> {
  @override
  final typeId = 4;

  @override
  BangumiTag read(BinaryReader reader) {
    final count = reader.readByte();
    if (count > 3) throw StateError("Unsupported Hive schema");
    final fields = <int, dynamic>{
      for (var i = 0; i < count; i++) reader.readByte(): reader.read(),
    };
    return BangumiTag(
      fields[0] as String,
      (fields[1] as num).toInt(),
      (fields[2] as num).toInt(),
    );
  }

  @override
  void write(BinaryWriter writer, BangumiTag obj) { writer.writeByte(3);writer.writeByte(0);writer.write(obj.name);writer.writeByte(1);writer.write(obj.count);writer.writeByte(2);writer.write(obj.totalCount);}
}


