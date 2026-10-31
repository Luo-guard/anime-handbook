import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:hive_ce/hive.dart';
import 'kazumi_models.dart';

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

