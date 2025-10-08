  libavformat    59. 27.100 / 59. 27.100
  libavdevice    59.  7.100 / 59.  7.100
  libavfilter     8. 44.100 /  8. 44.100
  libswscale      6.  7.100 /  6.  7.100
  libswresample   4.  7.100 /  4.  7.100
  libpostproc    56.  6.100 / 56.  6.100
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/clip_0.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf58.29.100
  Duration: 00:00:10.54, start: 0.000000, bitrate: 9008 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 768x1280, 8995 kb/s, 24 fps, 24 tbr, 12288 tbn (default)
    Metadata:
      handler_name    : VideoHandler
      vendor_id       : [0][0][0][0]
Input #1, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/clip_1.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf58.29.100
  Duration: 00:00:10.54, start: 0.000000, bitrate: 8757 kb/s
  Stream #1:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 768x1280, 8744 kb/s, 24 fps, 24 tbr, 12288 tbn (default)
    Metadata:
      handler_name    : VideoHandler
      vendor_id       : [0][0][0][0]
Filtergraph 'format=yuv420p' was specified through the -vf/-af/-filter option for output stream 0:0, which is fed from a complex filtergraph.
-vf/-af/-filter and -filter_complex cannot be used together for the same stream.
Server error: Error: FFmpeg failed
    at file:///app/server.js:21:16
    at ChildProcess.exithandler (node:child_process:430:5)
    at ChildProcess.emit (node:events:517:28)
    at maybeClose (node:internal/child_process:1098:16)
    at Socket.<anonymous> (node:internal/child_process:450:11)
    at Socket.emit (node:events:517:28)
    at Pipe.<anonymous> (node:net:350:12)
ffmpeg version 5.1.7-0+deb12u1 Copyright (c) 2000-2025 the FFmpeg developers
  built with gcc 12 (Debian 12.2.0-14+deb12u1)
  configuration: --prefix=/usr --extra-version=0+deb12u1 --toolchain=hardened --libdir=/usr/lib/x86_64-linux-gnu --incdir=/usr/include/x86_64-linux-gnu --arch=amd64 --enable-gpl --disable-stripping --enable-gnutls --enable-ladspa --enable-libaom --enable-libass --enable-libbluray --enable-libbs2b --enable-libcaca --enable-libcdio --enable-libcodec2 --enable-libdav1d --enable-libflite --enable-libfontconfig --enable-libfreetype --enable-libfribidi --enable-libglslang --enable-libgme --enable-libgsm --enable-libjack --enable-libmp3lame --enable-libmysofa --enable-libopenjpeg --enable-libopenmpt --enable-libopus --enable-libpulse --enable-librabbitmq --enable-librist --enable-librubberband --enable-libshine --enable-libsnappy --enable-libsoxr --enable-libspeex --enable-libsrt --enable-libssh --enable-libsvtav1 --enable-libtheora --enable-libtwolame --enable-libvidstab --enable-libvorbis --enable-libvpx --enable-libwebp --enable-libx265 --enable-libxml2 --enable-libxvid --enable-libzimg --enable-libzmq --enable-libzvbi --enable-lv2 --enable-omx --enable-openal --enable-opencl --enable-opengl --enable-sdl2 --disable-sndio --enable-libjxl --enable-pocketsphinx --enable-librsvg --enable-libmfx --enable-libdc1394 --enable-libdrm --enable-libiec61883 --enable-chromaprint --enable-frei0r --enable-libx264 --enable-libplacebo --enable-librav1e --enable-shared
  libavutil      57. 28.100 / 57. 28.100
    compatible_brands: isomiso2avc1mp41
  libavcodec     59. 37.100 / 59. 37.100
    at maybeClose (node:internal/child_process:1098:16)
      handler_name    : VideoHandler
    encoder         : Lavf58.29.100
    at ChildProcess._handle.onexit (node:internal/child_process:303:5)
  libavformat    59. 27.100 / 59. 27.100
      vendor_id       : [0][0][0][0]
  Duration: 00:00:10.54, start: 0.000000, bitrate: 9008 kb/s
  libavdevice    59.  7.100 / 59.  7.100
    compatible_brands: isomiso2avc1mp41
Filtergraph 'format=yuv420p' was specified through the -vf/-af/-filter option for output stream 0:0, which is fed from a complex filtergraph.
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 768x1280, 8995 kb/s, 24 fps, 24 tbr, 12288 tbn (default)
    at ChildProcess.exithandler (node:child_process:430:5)
  libavfilter     8. 44.100 /  8. 44.100
    encoder         : Lavf58.29.100
    Metadata:
  Duration: 00:00:10.54, start: 0.000000, bitrate: 8757 kb/s
    at ChildProcess.emit (node:events:517:28)
  libswscale      6.  7.100 /  6.  7.100
  Stream #1:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 768x1280, 8744 kb/s, 24 fps, 24 tbr, 12288 tbn (default)
      handler_name    : VideoHandler
-vf/-af/-filter and -filter_complex cannot be used together for the same stream.
    Metadata:
  libswresample   4.  7.100 /  4.  7.100
      vendor_id       : [0][0][0][0]
  libpostproc    56.  6.100 / 56.  6.100
Input #1, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/clip_1.mp4':
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/clip_0.mp4':
  Metadata:
Server error: Error: FFmpeg failed
  Metadata:
    major_brand     : isom
    major_brand     : isom
    minor_version   : 512
    at file:///app/server.js:21:16
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf58.29.100
  Duration: 00:00:10.54, start: 0.000000, bitrate: 9008 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 768x1280, 8995 kb/s, 24 fps, 24 tbr, 12288 tbn (default)
    Metadata:
      handler_name    : VideoHandler
      vendor_id       : [0][0][0][0]
Input #1, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/clip_1.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf58.29.100
  Duration: 00:00:10.54, start: 0.000000, bitrate: 8757 kb/s
  Stream #1:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 768x1280, 8744 kb/s, 24 fps, 24 tbr, 12288 tbn (default)
    Metadata:
      handler_name    : VideoHandler
      vendor_id       : [0][0][0][0]
Filtergraph 'format=yuv420p' was specified through the -vf/-af/-filter option for output stream 0:0, which is fed from a complex filtergraph.
-vf/-af/-filter and -filter_complex cannot be used together for the same stream.
Server error: Error: FFmpeg failed
    at file:///app/server.js:21:16
    at ChildProcess.exithandler (node:child_process:430:5)
    at ChildProcess.emit (node:events:517:28)
    at maybeClose (node:internal/child_process:1098:16)
    at Socket.<anonymous> (node:internal/child_process:450:11)
    at Socket.emit (node:events:517:28)
    at Pipe.<anonymous> (node:net:350:12)
ffmpeg version 5.1.7-0+deb12u1 Copyright (c) 2000-2025 the FFmpeg developers
  built with gcc 12 (Debian 12.2.0-14+deb12u1)
  configuration: --prefix=/usr --extra-version=0+deb12u1 --toolchain=hardened --libdir=/usr/lib/x86_64-linux-gnu --incdir=/usr/include/x86_64-linux-gnu --arch=amd64 --enable-gpl --disable-stripping --enable-gnutls --enable-ladspa --enable-libaom --enable-libass --enable-libbluray --enable-libbs2b --enable-libcaca --enable-libcdio --enable-libcodec2 --enable-libdav1d --enable-libflite --enable-libfontconfig --enable-libfreetype --enable-libfribidi --enable-libglslang --enable-libgme --enable-libgsm --enable-libjack --enable-libmp3lame --enable-libmysofa --enable-libopenjpeg --enable-libopenmpt --enable-libopus --enable-libpulse --enable-librabbitmq --enable-librist --enable-librubberband --enable-libshine --enable-libsnappy --enable-libsoxr --enable-libspeex --enable-libsrt --enable-libssh --enable-libsvtav1 --enable-libtheora --enable-libtwolame --enable-libvidstab --enable-libvorbis --enable-libvpx --enable-libwebp --enable-libx265 --enable-libxml2 --enable-libxvid --enable-libzimg --enable-libzmq --enable-libzvbi --enable-lv2 --enable-omx --enable-openal --enable-opencl --enable-opengl --enable-sdl2 --disable-sndio --enable-libjxl --enable-pocketsphinx --enable-librsvg --enable-libmfx --enable-libdc1394 --enable-libdrm --enable-libiec61883 --enable-chromaprint --enable-frei0r --enable-libx264 --enable-libplacebo --enable-librav1e --enable-shared
  libavutil      57. 28.100 / 57. 28.100
  libavcodec     59. 37.100 / 59. 37.100
  libavformat    59. 27.100 / 59. 27.100
  libavdevice    59.  7.100 / 59.  7.100
  libavfilter     8. 44.100 /  8. 44.100
  libswscale      6.  7.100 /  6.  7.100
  libswresample   4.  7.100 /  4.  7.100
  libpostproc    56.  6.100 / 56.  6.100
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/clip_0.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
