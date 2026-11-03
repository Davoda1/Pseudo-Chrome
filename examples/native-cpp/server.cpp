/* SPDX-License-Identifier: AGPL-3.0-only */
// Minimal demonstration server; compile before selecting Native mode.
// Not a production HTTP parser. It serves one fixed HTML response.
#include <cstdlib>
#include <charconv>
#include <cstring>
#include <iostream>
#include <string>
#include <csignal>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
using Socket = SOCKET;
static void closeSocket(Socket s) { closesocket(s); }
#else
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <sys/time.h>
using Socket = int;
static constexpr int INVALID_SOCKET = -1;
static void closeSocket(Socket s) { close(s); }
#endif

int main() {
#ifdef _WIN32
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return 1;
#endif
#ifndef _WIN32
    std::signal(SIGPIPE, SIG_IGN);
#endif
    // The bind interface is fixed; environment settings cannot widen access.
    constexpr const char* host = "127.0.0.1";
    const char* portText = std::getenv("PORT");
    if (!portText) {
        std::cerr << "Start this example through Pseudo-Chrome with PORT set.\n";
        return 1;
    }
    int port = 0;
    const char* portEnd = portText + std::strlen(portText);
    const auto parsed = std::from_chars(portText, portEnd, port);
    if (parsed.ec != std::errc{} || parsed.ptr != portEnd || port < 1 || port > 65535) {
        std::cerr << "PORT must be an integer from 1 to 65535.\n";
        return 1;
    }
    Socket server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (server == INVALID_SOCKET) return 1;
    int reuse = 1;
    setsockopt(server, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof(reuse));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<unsigned short>(port));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(server, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0 ||
        listen(server, 16) != 0) {
        std::cerr << "Cannot bind the supplied local port.\n";
        closeSocket(server);
        return 1;
    }
    std::cout << "Native C++ example listening on http://" << host << ':' << port << std::endl;
    const std::string body = "<!doctype html><html lang='en'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Native C++ website example</title><style>:root{color-scheme:light dark;font:17px/1.7 system-ui}body{max-width:760px;margin:60px auto;padding:0 24px}h1{font-size:36px}</style><h1>A compiled C++ backend.</h1><p>This page is returned by a native executable managed by Pseudo-Chrome.</p><p>The server binds only to loopback on the PORT supplied by the application. No compiler is used during startup.</p></html>";
    const std::string response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
    for (;;) {
        Socket client = accept(server, nullptr, nullptr);
        if (client == INVALID_SOCKET) continue;
#ifdef _WIN32
        DWORD timeout = 5000;
#else
        timeval timeout{5, 0};
#endif
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
        setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
        char request[8192];
        const int received = static_cast<int>(recv(client, request, sizeof(request), 0));
        if (received > 0) {
            std::size_t sent = 0;
            while (sent < response.size()) {
                const int written = static_cast<int>(send(client, response.data() + sent, static_cast<int>(response.size() - sent), 0));
                if (written <= 0) break;
                sent += static_cast<std::size_t>(written);
            }
        }
        closeSocket(client);
    }
}
