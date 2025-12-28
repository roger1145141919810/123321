const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let rooms = {};
let roomTimers = {}; // 存放各房間的計時器

io.on('connection', (socket) => {
    // 【加入房間】
    socket.on('joinRoom', ({ roomId, username }) => {
        if (!rooms[roomId]) rooms[roomId] = { hostId: socket.id, players: [], status: 'waiting' };
        const room = rooms[roomId];

        if (room.status === 'playing') return socket.emit('errorMessage', '❌ 遊戲進行中，無法進入。');
        if (room.players.some(p => p.name === username)) return socket.emit('errorMessage', '❌ 名字有人用囉。');

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        const player = { id: socket.id, name: username, role: null, isHost: (socket.id === room.hostId), isAlive: true, usedPotions: [] };
        room.players.push(player);

        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
        socket.emit('hostStatus', player.isHost);
    });

    // 【房長踢人】
    socket.on('kickPlayer', (targetId) => {
        const room = rooms[socket.roomId];
        if (room && socket.id === room.hostId && room.status === 'waiting') {
            io.to(targetId).emit('errorMessage', '你已被房長踢出房間。');
            io.sockets.sockets.get(targetId)?.disconnect();
        }
    });

    // 【手動移交房長】
    socket.on('transferHost', (targetId) => {
        const room = rooms[socket.roomId];
        if (room && socket.id === room.hostId && room.status === 'waiting') {
            const newHost = room.players.find(p => p.id === targetId);
            if (newHost) {
                room.players.forEach(p => p.isHost = false); // 重置所有人身分
                room.hostId = newHost.id;
                newHost.isHost = true;
                
                io.to(socket.roomId).emit('updatePlayers', { players: room.players, status: room.status });
                io.to(targetId).emit('hostStatus', true); // 通知新房長
                socket.emit('hostStatus', false); // 通知舊房長權限移除
                io.to(socket.roomId).emit('receiveMessage', { name: "系統", text: `👑 房長已轉移給 ${newHost.name}。`, isSystem: true });
            }
        }
    });

    // 【開始遊戲】
    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || room.players.length < 6) return socket.emit('errorMessage', '❌ 至少需要 6 人才能開始。');

        room.status = 'playing';
        const rolesPool = ['狼人', '狼人', '預言家', '女巫', '村民', '村民', '獵人'];
        room.players.forEach((p, i) => {
            p.isAlive = true;
            p.role = rolesPool[i % rolesPool.length];
            io.to(p.id).emit('assignRole', p.role);
        });
        io.to(socket.roomId).emit('updatePlayers', { players: room.players, status: room.status });
    });

    // 【白天計時器啟動】
    socket.on('startDayTimer', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || socket.id !== room.hostId) return;

        room.status = 'day';
        room.skipVotes = new Set();
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);

        let timeLeft = 300; 
        io.to(roomId).emit('timerUpdate', timeLeft);

        roomTimers[roomId] = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(roomTimers[roomId]);
                io.to(roomId).emit('receiveMessage', { name: "系統", text: "⏰ 時間到！白天結束。", isSystem: true });
            }
        }, 1000);
    });

   // 【跳過白天投票】
    socket.on('castSkipVote', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || room.status !== 'day') return;

        room.skipVotes.add(socket.id);
        const aliveCount = room.players.filter(p => p.isAlive).length;
        const required = Math.max(1, aliveCount - 1); // 確保至少需要1票

        io.to(roomId).emit('receiveMessage', { 
            name: "系統", 
            text: `⏭️ ${socket.username} 投票跳過 (${room.skipVotes.size}/${required})`, 
            isSystem: true 
        });

        if (room.skipVotes.size >= required) {
            // 1. 停止白天的 5 分鐘計時器
            if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
            
            // 2. 廣播訊息
            io.to(roomId).emit('receiveMessage', { name: "系統", text: "✅ 票數達成，跳過白天，進入黑夜。", isSystem: true });
            
            // 3. 變更狀態並同步到前端
            room.status = 'playing';
            io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
            
            // 4. 關鍵：重新發送身分以觸發前端 CSS 切換成黑夜模式
            room.players.forEach(p => {
                io.to(p.id).emit('assignRole', p.role);
            });
        }
    });

    // 【預言家查驗】
    socket.on('checkRole', (targetId) => {
        const room = rooms[socket.roomId];
        const target = room.players.find(p => p.id === targetId);
        if (target) {
            const side = target.role === '狼人' ? '壞人 (狼人)' : '好人';
            socket.emit('checkResult', `查驗結果：${target.name} 是 ${side}`);
        }
    });

    // 【訊息發送】
    socket.on('sendMessage', (d) => io.to(socket.roomId).emit('receiveMessage', d));

    // 【斷線處理】
    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room) return;

        if (room.status === 'waiting') {
            room.players = room.players.filter(p => p.id !== socket.id);
            // 房長交接（隨機）
            if (socket.id === room.hostId && room.players.length > 0) {
                const randomIndex = Math.floor(Math.random() * room.players.length);
                const newHost = room.players[randomIndex];
                room.hostId = newHost.id;
                newHost.isHost = true;
                
                // 關鍵：發送 hostStatus 給隨機選中的新房長
                io.to(newHost.id).emit('hostStatus', true); 
                
                io.to(roomId).emit('receiveMessage', { name: "系統", text: `👑 房長離開，新房長由 ${newHost.name} 隨機擔任。`, isSystem: true });
            }
        } else {
            const p = room.players.find(x => x.id === socket.id);
            if (p && p.isAlive) {
                p.isAlive = false;
                io.to(roomId).emit('receiveMessage', { name: "系統", text: `⚠️ ${p.name} 斷線淘汰！`, isSystem: true });
                checkGameOver(roomId);
            }
        }
        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
    });

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        const alives = room.players.filter(p => p.isAlive);
        const wolves = alives.filter(p => p.role === '狼人');
        const humans = alives.filter(p => p.role !== '狼人');

        if (wolves.length === 0) endGame(roomId, "好人陣營");
        else if (humans.length === 0) endGame(roomId, "狼人陣營");
    }

    function endGame(roomId, winner) {
        io.to(roomId).emit('gameOver', { winner, allRoles: rooms[roomId].players });
        rooms[roomId].status = 'waiting';
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
    }
});

server.listen(process.env.PORT || 3000);
