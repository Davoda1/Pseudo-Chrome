/* SPDX-License-Identifier: AGPL-3.0-only */
/* Native process lifetime supervisor for the application's Windows backends.
 * The child and every descendant belong to a Job Object. Terminating this
 * supervisor closes the only job handle and terminates the complete tree.
 * Normal shutdown uses a private control pipe and waits for the job to empty
 * before exiting, so callers can immediately replace backend executables.
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
/* Reserved supervisor result: shutdown could not be verified. */
#define SHUTDOWN_INCOMPLETE 0x50534346
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

static wchar_t *command_line(int argc, wchar_t **argv) {
    size_t size=1;
    for(int i=1;i<argc;i++) size+=2*wcslen(argv[i])+4;
    wchar_t *line=calloc(size,sizeof(wchar_t)), *out=line;
    if(!line)return NULL;
    for(int i=1;i<argc;i++) {
        if(i>1)*out++=L' ';
        *out++=L'"';
        const wchar_t *p=argv[i];
        while(*p) {
            size_t slashes=0;
            while(*p==L'\\'){slashes++;p++;}
            if(*p==L'"') {
                for(size_t j=0;j<slashes*2+1;j++)*out++=L'\\';
                *out++=*p++;
            } else if(!*p) {
                for(size_t j=0;j<slashes*2;j++)*out++=L'\\';
            } else {
                for(size_t j=0;j<slashes;j++)*out++=L'\\';
                *out++=*p++;
            }
        }
        *out++=L'"';
    }
    *out=0;
    return line;
}

static HANDLE inherited_handle(DWORD id) {
    HANDLE original=GetStdHandle(id), copy=NULL;
    if(!original||original==INVALID_HANDLE_VALUE)return NULL;
    if(!DuplicateHandle(GetCurrentProcess(),original,GetCurrentProcess(),&copy,0,TRUE,DUPLICATE_SAME_ACCESS))return NULL;
    return copy;
}

static int shutdown_failed(HANDLE job, HANDLE process, const char *operation) {
    fprintf(stderr,"%s failed while stopping backend (Windows error %u)\n",operation,(unsigned int)GetLastError());
    if(process)CloseHandle(process);
    /* Kill-on-close remains the last-resort containment, but is asynchronous.
     * The reserved result tells the caller not to report a completed stop. */
    CloseHandle(job);
    return SHUTDOWN_INCOMPLETE;
}

static int supervise(HANDLE job, HANDLE process, HANDLE control, BOOL startup_failed) {
    BOOL stopping=startup_failed, root_exited=FALSE;
    DWORD exit_code=startup_failed?70:1;
    if(stopping&&!TerminateJobObject(job,70))return shutdown_failed(job,process,"TerminateJobObject");
    for(;;) {
        if(!stopping) {
            DWORD available=0;
            if(!PeekNamedPipe(control,NULL,0,NULL,&available,NULL)) {
                DWORD error=GetLastError();
                if(error!=ERROR_BROKEN_PIPE&&error!=ERROR_PIPE_NOT_CONNECTED)
                    return shutdown_failed(job,process,"Read shutdown control pipe");
                stopping=TRUE;
            } else if(available)stopping=TRUE;
            if(stopping&&!TerminateJobObject(job,0))return shutdown_failed(job,process,"TerminateJobObject");
        }
        if(!root_exited) {
            DWORD result=WaitForSingleObject(process,25);
            if(result==WAIT_OBJECT_0) {
                if(!stopping&&!GetExitCodeProcess(process,&exit_code))
                    return shutdown_failed(job,process,"GetExitCodeProcess");
                /* Release our reference before consulting ActiveProcesses:
                 * Windows decrements it after exit and process references close. */
                CloseHandle(process);process=NULL;root_exited=TRUE;
            } else if(result!=WAIT_TIMEOUT)return shutdown_failed(job,process,"WaitForSingleObject");
        } else Sleep(25);
        if(root_exited) {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting={0};
            if(!QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&accounting,sizeof(accounting),NULL))
                return shutdown_failed(job,process,"QueryInformationJobObject");
            if(accounting.ActiveProcesses==0)break;
        }
    }
    CloseHandle(job);
    return startup_failed?70:stopping?0:(int)exit_code;
}

int wmain(int argc, wchar_t **argv) {
    if(argc<2){fputs("Usage: process-runner.exe executable [arguments...]\n",stderr);return 64;}
    HANDLE control=GetStdHandle(STD_INPUT_HANDLE);
    if(!control||control==INVALID_HANDLE_VALUE||GetFileType(control)!=FILE_TYPE_PIPE||
       !SetHandleInformation(control,HANDLE_FLAG_INHERIT,0)) {
        fputs("A private shutdown control pipe is required.\n",stderr);return 70;
    }
    HANDLE job=CreateJobObjectW(NULL,NULL);
    if(!job){fprintf(stderr,"CreateJobObject failed: %u\n",(unsigned int)GetLastError());return 70;}
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={0};
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))){fprintf(stderr,"SetInformationJobObject failed: %u\n",(unsigned int)GetLastError());CloseHandle(job);return 70;}
    wchar_t *line=command_line(argc,argv);
    if(!line){CloseHandle(job);return 70;}
    STARTUPINFOW startup={0};PROCESS_INFORMATION process={0};startup.cb=sizeof(startup);
    SECURITY_ATTRIBUTES security={sizeof(security),NULL,TRUE};
    /* The backend must see EOF on stdin, never inherit the control channel. */
    startup.hStdInput=CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,&security,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
    startup.hStdOutput=inherited_handle(STD_OUTPUT_HANDLE);startup.hStdError=inherited_handle(STD_ERROR_HANDLE);
    if(startup.hStdInput==INVALID_HANDLE_VALUE||!startup.hStdOutput||!startup.hStdError) {
        fputs("Cannot prepare backend standard handles.\n",stderr);
        if(startup.hStdInput!=INVALID_HANDLE_VALUE)CloseHandle(startup.hStdInput);
        if(startup.hStdOutput)CloseHandle(startup.hStdOutput);
        if(startup.hStdError)CloseHandle(startup.hStdError);
        free(line);CloseHandle(job);return 70;
    }
    startup.dwFlags=STARTF_USESTDHANDLES;
    BOOL created=CreateProcessW(argv[1],line,NULL,NULL,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW,NULL,NULL,&startup,&process);
    DWORD failure=GetLastError();free(line);
    CloseHandle(startup.hStdInput);CloseHandle(startup.hStdOutput);CloseHandle(startup.hStdError);
    if(!created){fprintf(stderr,"Cannot start backend (Windows error %u)\n",(unsigned int)failure);CloseHandle(job);return 127;}
    if(!AssignProcessToJobObject(job,process.hProcess)) {
        fprintf(stderr,"Cannot contain backend process tree (Windows error %u)\n",(unsigned int)GetLastError());
        CloseHandle(process.hThread);
        if(!TerminateProcess(process.hProcess,70)||WaitForSingleObject(process.hProcess,INFINITE)!=WAIT_OBJECT_0)
            return shutdown_failed(job,process.hProcess,"Terminate unassigned backend");
        CloseHandle(process.hProcess);CloseHandle(job);return 70;
    }
    BOOL startup_failed=ResumeThread(process.hThread)==(DWORD)-1;
    if(startup_failed)fprintf(stderr,"Cannot resume backend (Windows error %u)\n",(unsigned int)GetLastError());
    CloseHandle(process.hThread);
    return supervise(job,process.hProcess,control,startup_failed);
}
