-- Métadonnées inconnues pour les fichiers existants : aucune réanalyse implicite.
ALTER TABLE media_files ADD COLUMN video_codec TEXT CHECK (video_codec IS NULL OR length(trim(video_codec)) > 0);
ALTER TABLE media_files ADD COLUMN audio_codec TEXT CHECK (audio_codec IS NULL OR length(trim(audio_codec)) > 0);
ALTER TABLE media_files ADD COLUMN width INTEGER CHECK (width IS NULL OR width > 0);
ALTER TABLE media_files ADD COLUMN height INTEGER CHECK (height IS NULL OR height > 0);
ALTER TABLE media_files ADD COLUMN fps REAL CHECK (fps IS NULL OR fps > 0);
ALTER TABLE media_files ADD COLUMN audio_language TEXT CHECK (audio_language IS NULL OR length(trim(audio_language)) > 0);
