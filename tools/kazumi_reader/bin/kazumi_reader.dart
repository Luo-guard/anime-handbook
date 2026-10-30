import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

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
  void write(BinaryWriter writer, BangumiItem obj) =>
      throw UnsupportedError('read-only');
}

class CollectedBangumiAdapter extends TypeAdapter<CollectedBangumi> {
  @override
  final typeId = 3;

  @override
  CollectedBangumi read(BinaryReader reader) {
    final count = reader.readByte();
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
  void write(BinaryWriter writer, CollectedBangumi obj) =>
      throw UnsupportedError('read-only');
}

class BangumiTagAdapter extends TypeAdapter<BangumiTag> {
  @override
  final typeId = 4;

  @override
  BangumiTag read(BinaryReader reader) {
    final count = reader.readByte();
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
  void write(BinaryWriter writer, BangumiTag obj) =>
      throw UnsupportedError('read-only');
}

Future<void> main(List<String> args) async {
  if (args.length != 1) {
    stderr.writeln('Usage: kazumi_reader <collectibles.hive>');
    exitCode = 64;
    return;
  }

  final source = File(args.first);
  if (!await source.exists()) {
    stderr.writeln('Kazumi database does not exist: ${source.path}');
    exitCode = 66;
    return;
  }

  Directory? tempDirectory;
  Box<CollectedBangumi>? box;
  try {
    // File.readAsBytes is intentionally the only access to Kazumi data.
    // Hive operates on the copied bytes and can never write to the source.
    final Uint8List bytes = await source.readAsBytes();
    tempDirectory = await Directory.systemTemp.createTemp('anime-handbook-');
    Hive.init(tempDirectory.path);
    Hive
      ..registerAdapter(BangumiItemAdapter())
      ..registerAdapter(CollectedBangumiAdapter())
      ..registerAdapter(BangumiTagAdapter());
    box = await Hive.openBox<CollectedBangumi>(
      'kazumi_collectibles_readonly',
      bytes: bytes,
    );

    final output = box.values.map((entry) {
      final item = entry.bangumiItem;
      return {
        'id': item.id,
        'type': entry.type,
        'updated_at': entry.time.toIso8601String(),
        'name': item.name,
        'name_cn': item.nameCn,
        'summary': item.summary,
        'air_date': item.airDate,
        'image_url': item.images['large'] ??
            item.images['common'] ??
            item.images['medium'] ??
            '',
      };
    }).toList();
    stdout.write(jsonEncode(output));
  } catch (error) {
    stderr.writeln('Unable to read Kazumi database: $error');
    exitCode = 2;
  } finally {
    await box?.close();
    if (tempDirectory != null && await tempDirectory.exists()) {
      await tempDirectory.delete(recursive: true);
    }
  }
}

