/*
 * The name ffmpeg-kit's fftools include for the place exit_program jumps
 * back to. Each run has its own, on its own thread; core/src/engine.c
 * defines it and sets it up through ffmpeg_execute and ffprobe_execute.
 */
#ifndef FFMPEG_KIT_EXCEPTION_H
#define FFMPEG_KIT_EXCEPTION_H

#include <setjmp.h>
#include <stdio.h>

extern __thread jmp_buf ex_buf__;

#endif
