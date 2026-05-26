"use strict";

const SQL_WASM_PATH =
  "https://doemeyer.github.io/sqlite-viewer/js/sql-wasm.wasm";

const SQL_FROM_REGEX = /FROM\s+((?=['"])((["'])(?<g1>[^'"]+))|(?<g2>\w+))/mi;
const SQL_LIMIT_REGEX = /LIMIT\s+(\d+)(?:\s*,\s*(\d+))?/mi;
const SQL_SELECT_REGEX = /SELECT\s+[^;]+\s+FROM\s+/mi;

let db = null;
let lastCachedQueryCount = { select: "", count: 0 };
let loadedTableNames = [];
const editor = ace.edit("sql-editor");
const errorBox = $("#error");
const infoBox = $("#info");

const selectFormatter = function (item) {
    const index = item.text.indexOf("(");
    if (index > -1) {
        const name = item.text.substring(0, index);
        const tableName = item.text.substring(index - 1);
        return $(`<span>${name}<span style="color:#ccc">${tableName}</span></span>`);
    } else {
        return item.text;
    }
};

// Query History Manager
const QueryHistory = {
    STORAGE_KEY: 'sqlite-viewer-query-history',
    MAX_QUERIES: 100,
    queries: [],
    sidebarCollapsed: false,

    // Initialize on page load
    init() {
        this.loadHistory();
        this.renderHistory();
        this.attachEventListeners();
        this.restoreSidebarState();
        this.startTimestampUpdates();

        // Listen for storage events from other tabs
        window.addEventListener('storage', (e) => {
            if (e.key === this.STORAGE_KEY) {
                this.loadHistory();
                this.renderHistory();
            }
        });
    },

    // Load from localStorage
    loadHistory() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (stored) {
                const data = JSON.parse(stored);
                this.queries = data.queries || [];
                this.sidebarCollapsed = data.sidebarCollapsed || false;
            } else {
                this.queries = [];
                this.sidebarCollapsed = false;
            }
        } catch (e) {
            console.error('Failed to parse query history:', e);
            this.queries = [];
            this.sidebarCollapsed = false;
        }
    },

    // Save to localStorage
    saveHistory() {
        try {
            const data = {
                queries: this.queries,
                sidebarCollapsed: this.sidebarCollapsed
            };
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                console.warn('localStorage quota exceeded, reducing history size');
                this.MAX_QUERIES = 50;
                this.queries = this.queries.slice(0, 50);
                try {
                    const data = {
                        queries: this.queries,
                        sidebarCollapsed: this.sidebarCollapsed
                    };
                    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
                } catch (e2) {
                    console.error('Failed to save query history even after reduction:', e2);
                }
            } else {
                console.error('Failed to save query history:', e);
            }
        }
    },

    // Add query (called from executeSql)
    addQuery(sql) {
        const trimmed = sql.trim();
        if (!trimmed) return;

        // Truncate very long queries
        const maxLength = 5000;
        const storedSql = trimmed.length > maxLength ? trimmed.substring(0, maxLength) + '...[truncated]' : trimmed;

        // Deduplication: remove if exists, will re-add at top
        const existingIndex = this.queries.findIndex(q => q.sql === storedSql);
        if (existingIndex > -1) {
            this.queries.splice(existingIndex, 1);
        }

        // Add new query at the beginning
        const query = {
            id: Date.now().toString(),
            sql: storedSql,
            timestamp: Date.now(),
            truncated: this.truncateQuery(storedSql, 50)
        };

        this.queries.unshift(query);

        // Enforce max limit
        if (this.queries.length > this.MAX_QUERIES) {
            this.queries = this.queries.slice(0, this.MAX_QUERIES);
        }

        this.saveHistory();
        this.renderHistory();
    },

    // Truncate query for display
    truncateQuery(sql, maxLength) {
        if (sql.length <= maxLength) return sql;
        return sql.substring(0, maxLength) + '...';
    },

    // Format timestamp
    formatTimestamp(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (seconds < 60) return 'Gerade eben';
        if (minutes < 60) return `${minutes} Min. her`;
        if (hours < 24) return `${hours} Std. her`;
        if (days === 1) return 'Gestern';
        if (days < 7) return `${days} Tage her`;

        const date = new Date(timestamp);
        const yearAgo = now - (365 * 24 * 60 * 60 * 1000);

        return new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            year: timestamp < yearAgo ? 'numeric' : undefined
        }).format(date);
    },

    // Render query list
    renderHistory() {
        const container = document.getElementById('query-history-list');
        if (!container) return;

        if (this.queries.length === 0) {
            container.innerHTML = '<div class="text-center text-muted p-4 small">Noch keine Abfragen. Führe eine Abfrage aus, um sie hier zu sehen.</div>';
            return;
        }

        container.innerHTML = this.queries.map(query => {
            const timestamp = this.formatTimestamp(query.timestamp);
            const escapedSql = this.escapeHtml(query.sql);
            const escapedTruncated = this.escapeHtml(query.truncated);

            return `
                <div class="query-item bg-white border rounded p-2 mb-2" data-query-id="${query.id}" data-sql="${this.escapeAttr(query.sql)}">
                    <div class="d-flex flex-column">
                        <pre class="query-sql mb-0 small font-monospace text-secondary"><code>${escapedTruncated}</code></pre>
                        <time class="query-timestamp small text-muted mt-2" datetime="${new Date(query.timestamp).toISOString()}">${timestamp}</time>
                    </div>
                    <div class="query-tooltip position-fixed bg-white border border-primary rounded shadow-lg p-3">
                        <pre class="mb-0 small font-monospace"><code>${escapedSql}</code></pre>
                    </div>
                </div>
            `;
        }).join('');

        // Attach click handlers
        container.querySelectorAll('.query-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const sql = e.currentTarget.getAttribute('data-sql');
                this.loadQueryToEditor(sql);
            });
        });
    },

    // Load query into ACE editor
    loadQueryToEditor(sql) {
        editor.setValue(sql, -1);
        editor.focus();
    },

    // Clear all history
    clearHistory() {
        if (confirm('Gesamten Abfrage-Verlauf löschen? Das kann nicht rückgängig gemacht werden.')) {
            this.queries = [];
            this.saveHistory();
            this.renderHistory();
        }
    },

    // Toggle sidebar
    toggleSidebar() {
        this.sidebarCollapsed = !this.sidebarCollapsed;
        this.saveHistory();
        this.applySidebarState();
    },

    // Apply sidebar collapsed state
    applySidebarState() {
        const sidebar = document.getElementById('query-history-sidebar');
        const toggle = document.getElementById('sidebar-toggle');

        if (!sidebar || !toggle) return;

        if (this.sidebarCollapsed) {
            sidebar.classList.add('collapsed');
            toggle.querySelector('.icon-expand').style.display = 'block';
            toggle.querySelector('.icon-collapse').style.display = 'none';
        } else {
            sidebar.classList.remove('collapsed');
            toggle.querySelector('.icon-expand').style.display = 'none';
            toggle.querySelector('.icon-collapse').style.display = 'block';
        }
    },

    // Restore sidebar state from localStorage
    restoreSidebarState() {
        this.applySidebarState();
    },

    // Attach event listeners
    attachEventListeners() {
        // Sidebar toggle
        const toggle = document.getElementById('sidebar-toggle');
        if (toggle) {
            toggle.addEventListener('click', () => this.toggleSidebar());
        }

        // Clear history button
        const clearBtn = document.getElementById('clear-history-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearHistory());
        }
    },

    // Update timestamps periodically
    startTimestampUpdates() {
        setInterval(() => {
            const timestamps = document.querySelectorAll('.query-timestamp');
            timestamps.forEach((el, index) => {
                if (this.queries[index]) {
                    el.textContent = this.formatTimestamp(this.queries[index].timestamp);
                }
            });
        }, 60000); // Update every minute
    },

    // HTML escape utilities
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    escapeAttr(text) {
        return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
};

initialize();

function initialize() {
    let fileReaderOpts = {
        readAsDefault: "ArrayBuffer", on: {
            load: function (e) {
                loadDB(e.target.result);
            }
        }
    };

    let toggleFullScreen = function () {
        const container = $("#main-container");
        const resizerExpandIcon = $("#resizer-expand");
        const resizerCollapseIcon = $("#resizer-collapse");

        container.toggleClass("container container-fluid");
        resizerExpandIcon.toggle();
        resizerCollapseIcon.toggle();
    };
    $("#resizer").click(toggleFullScreen);
    $("#sql-editor").keydown(onKeyDown);

    if (typeof FileReader === "undefined" || typeof WebAssembly === "undefined") {
        $("#dropzone, #dropzone-dialog").hide();
        $("#compat-error").toggleClass("d-none", false);
    } else {
        $("#dropzone, #dropzone-dialog").fileReaderJS(fileReaderOpts);
    }

    //Initialize editor
    editor.setTheme("ace/theme/chrome");
    editor.renderer.setShowGutter(false);
    editor.renderer.setShowPrintMargin(false);
    editor.renderer.setPadding(20);
    editor.renderer.setScrollMargin(8, 8, 0, 0);
    editor.setHighlightActiveLine(false);
    editor.getSession().setUseWrapMode(true);
    editor.getSession().setMode("ace/mode/sql");
    editor.setOptions({minLines: 3, maxLines: 20});
    editor.setFontSize(16);

    $(".no-propagate").on("click", function (el) {
        el.stopPropagation();
    });

    //Check url to load remote DB
    $.urlParam = function (name) {
        let results = new RegExp( `[\?&]${name}=([^&#]*)`).exec(window.location.href);
        if (results == null) {
            return null;
        } else {
            return results[1] || 0;
        }
    };
    const loadUrlDB = "examples/museum.db";
    if (loadUrlDB != null) {
        setIsLoading(true);
        const xhr = new XMLHttpRequest();
        xhr.open("GET", decodeURIComponent(loadUrlDB), true);
        xhr.responseType = "arraybuffer";
        xhr.onload = function (e) {
            loadDB(this.response);
        };
        xhr.onerror = function (e) {
            setIsLoading(false);
        };
        xhr.send();
    }

    // Initialize query history
    QueryHistory.init();
}

function loadDB(arrayBuffer) {
    setIsLoading(true);

    resetTableList();

    initSqlJs({locateFile: file => SQL_WASM_PATH}).then(function (SQL) {
        let tables = null;
        try {
            db = new SQL.Database(new Uint8Array(arrayBuffer));

            //Get all table names from master table
            tables = db.prepare("SELECT * FROM sqlite_master WHERE type='table' OR type='view' ORDER BY name");
        } catch (ex) {
            if (tables !== null) {
                tables.free();
            }
            setIsLoading(false);
            window.alert(ex);
            return;
        }

        let firstTableName = null;
        const tableList = $("#tables");

        while (tables.step()) {
            const rowObj = tables.getAsObject();
            const name = rowObj["name"];
            const type = rowObj["type"];

            if (firstTableName === null) {
                firstTableName = name;
            }
            const rowCount = getTableRowsCount(name);
            loadedTableNames.push(name);
            const tableType = type !== "table" ? `, ${type}` : "";
            tableList.append(`<option value="${name}">${name} (${rowCount} Zeilen${tableType})</option>`);
        }
        tables.free();

        //Select first table and show It
        tableList.val(firstTableName);
        doDefaultSelect(firstTableName);

        $("#output-box").fadeIn();
        $(".nouploadinfo").hide();
        $("#sample-db-link").hide();
        $("#dropzone").delay(50).animate({height: 75}, 500);
        $("#success-box").show();

        setIsLoading(false);
    });
}

function getTableRowsCount(name) {
    const sel = db.prepare(`SELECT COUNT(*) AS count FROM '${name}'`);
    if (sel.step()) {
        const count = sel.getAsObject()["count"];
        sel.free();
        return count;
    } else {
        sel.free();
        return -1;
    }
}

function getQueryRowCount(query) {
    if (query === lastCachedQueryCount.select) {
        return lastCachedQueryCount.count;
    }

    let queryReplaced = query.replace(SQL_SELECT_REGEX, "SELECT COUNT(*) AS count FROM ");

    if (queryReplaced !== query) {
        queryReplaced = queryReplaced.replace(SQL_LIMIT_REGEX, "");
        const sel = db.prepare(queryReplaced);
        if (sel.step()) {
            const count = sel.getAsObject()["count"];
            sel.free();

            lastCachedQueryCount.select = query;
            lastCachedQueryCount.count = count;

            return count;
        } else {
            sel.free();
            return -1;
        }
    } else {
        return -1;
    }
}

function getTableColumnTypes(tableName) {
    let result = new Map();
    const sel = db.prepare(`PRAGMA table_info('${tableName}')`);

    while (sel.step()) {
        const obj = sel.getAsObject();
        let type = obj["type"];
        if (obj["notnull"] === 1) {
            type += " NOT NULL";
        }
        if (obj["pk"] === 1) {
            type += " PRIMARY KEY";
        }
        result.set(obj.name, type);
    }
    sel.free();

    return result;
}

function resetTableList() {
    const tables = $("#tables");
    loadedTableNames = [];
    tables.empty();
    tables.append("<option></option>");
    tables.select2({
        placeholder: "Tabelle wählen",
        theme: "bootstrap-5",
        templateSelection: selectFormatter,
        templateResult: selectFormatter
    });
    tables.on("change", function (e) {
        doDefaultSelect(tables.val());
    });
}

function setIsLoading(isLoading) {
    const dropText = $("#drop-text");
    const loading = $("#drop-loading");
    if (isLoading) {
        dropText.hide();
        loading.toggleClass("d-none", false);
    } else {
        dropText.show();
        loading.toggleClass("d-none", true);
    }
}

function dropzoneClick() {
    $("#dropzone-dialog").click();
}

function doDefaultSelect(name) {
    const defaultSelect = `SELECT * FROM '${name}'`;
    editor.setValue(defaultSelect, -1);
    renderQuery(defaultSelect);
}

function refreshTableList() {
    if (!db) return;

    const tableList = $("#tables");
    const currentSelection = tableList.val();

    const stmt = db.prepare("SELECT * FROM sqlite_master WHERE type='table' OR type='view' ORDER BY name");
    const newTableNames = [];
    const tableData = [];

    while (stmt.step()) {
        const rowObj = stmt.getAsObject();
        newTableNames.push(rowObj["name"]);
        tableData.push(rowObj);
    }
    stmt.free();

    if (JSON.stringify(newTableNames) === JSON.stringify(loadedTableNames)) return;

    loadedTableNames = newTableNames;

    try { tableList.select2('destroy'); } catch(e) {}
    tableList.empty();
    tableList.append("<option></option>");

    for (const rowObj of tableData) {
        const name = rowObj["name"];
        const type = rowObj["type"];
        const rowCount = getTableRowsCount(name);
        const tableType = type !== "table" ? `, ${type}` : "";
        tableList.append(`<option value="${name}">${name} (${rowCount} Zeilen${tableType})</option>`);
    }

    tableList.select2({
        placeholder: "Tabelle wählen",
        theme: "bootstrap-5",
        templateSelection: selectFormatter,
        templateResult: selectFormatter
    });
    tableList.on("change", function() {
        doDefaultSelect(tableList.val());
    });

    if (currentSelection && newTableNames.includes(currentSelection)) {
        tableList.val(currentSelection).trigger('change.select2');
    }
}

function executeSql() {
    const query = editor.getValue();
    QueryHistory.addQuery(query);
    renderQuery(query);
    refreshTableList();
    $("#tables").val(getTableNameFromQuery(query));
}

function getTableNameFromQuery(query) {
    const sqlRegex = SQL_FROM_REGEX.exec(query);
    if (sqlRegex != null) {
        return sqlRegex.groups.g1 ?? sqlRegex.groups.g2;
    } else {
        return null;
    }
}

function parseLimitFromQuery(query) {
    const sqlRegex = SQL_LIMIT_REGEX.exec(query);
    if (sqlRegex != null) {
        let result = { max: 0, offset: 0 };

        if (sqlRegex.length > 2 && typeof sqlRegex[2] !== "undefined") {
            result.offset = parseInt(sqlRegex[1]);
            result.max = parseInt(sqlRegex[2]);
        } else {
            result.offset = 0;
            result.max = parseInt(sqlRegex[1]);
        }

        if (result.max == 0) {
            result.pages = 0;
            result.currentPage = 0;
            return result;
        }

        const queryRowsCount = getQueryRowCount(query);
        if (queryRowsCount != -1) {
            result.pages = Math.ceil(queryRowsCount / result.max);
        }
        result.currentPage = Math.floor(result.offset / result.max) + 1;
        result.rowCount = queryRowsCount;

        return result;
    } else {
        return null;
    }
}

function setPage(el, next) {
    if ($(el).hasClass("disabled")) return;

    const query = editor.getValue();
    const limit = parseLimitFromQuery(query);

    let pageToSet = 0;
    if (typeof next !== "undefined") {
        pageToSet = (next ? limit.currentPage : limit.currentPage - 2);
    } else {
        const page = window.prompt("Gehe zu Seite");
        if (!isNaN(page) && page >= 1 && page <= limit.pages) {
            pageToSet = page - 1;
        } else {
            return;
        }
    }

    const offset = (pageToSet * limit.max);
    editor.setValue(query.replace(SQL_LIMIT_REGEX, `LIMIT ${offset},${limit.max}`), -1);

    executeSql();
}

function refreshPagination(query) {
    const limit = parseLimitFromQuery(query);
    if (limit !== null && limit.pages > 0) {
        const pager = $("#pager");
        const pagePrev = $("#page-prev");
        const pageNext = $("#page-next");

        pager.attr("title", `Zeilenanzahl: ${limit.rowCount}`);
        bootstrap.Tooltip.getOrCreateInstance("#pager").hide();
        pager.text(limit.currentPage + " / " + limit.pages);

        if (limit.currentPage <= 1) {
            pagePrev.addClass("disabled");
        } else {
            pagePrev.removeClass("disabled");
        }

        if ((limit.currentPage + 1) > limit.pages) {
            pageNext.addClass("disabled");
        } else {
            pageNext.removeClass("disabled");
        }

        setPagerVisible(true);
    } else {
        setPagerVisible(false);
    }
}

function showError(msg) {
    $("#data").hide();
    setPagerVisible(false);
    errorBox.show();
    errorBox.text(msg);
}

function setPagerVisible(visible) {
    $("#bottom-bar").toggleClass("d-none", !visible);
    if (visible) {
        $("#footer").attr("style", "margin-top: -0.75rem !important");
    } else {
        $("#footer").css("margin-top", "");
    }
}

function htmlEncode(value) {
    return $("<div/>").text(value).html();
}

function renderQuery(query) {
    const dataBox = $("#data");
    const thead = dataBox.find("thead").find("tr");
    const tbody = dataBox.find("tbody");

    thead.empty();
    tbody.empty();
    errorBox.hide();
    infoBox.hide();
    dataBox.show();

    let columnTypes = new Map();
    const tableName = getTableNameFromQuery(query);
    if (tableName != null) {
        columnTypes = getTableColumnTypes(tableName);
    }

    let sel = null;
    try {
        sel = db.prepare(query);
    } catch (ex) {
        if (sel != null) {
            sel.free();
        }
        showError(ex);
        return;
    }

    let isEmptyTable = true;
    const columnNames = sel.getColumnNames();
    for (let i = 0; i < columnNames.length; i++) {
        const columnName = columnNames[i];
        const type = columnTypes.has(columnName) ? columnTypes.get(columnNames[i]) : "";
        thead.append(`<th><span data-bs-toggle="tooltip" title="${type}">${columnNames[i]}</span></th>`);
    }

    while (sel.step()) {
        isEmptyTable = false;
        const tr = $('<tr>');
        const s = sel.get();
        for (let i = 0; i < s.length; i++) {
            const columnName = columnNames[i];
            const type = columnTypes.has(columnName) ? columnTypes.get(columnName).toLowerCase() : "";
            if (type === "blob" || type === "blob sub_type binary") {
                if (s[i] === null) {
                    tr.append(`<td><span title="Blob">null</span></td>`);
                } else {
                    renderBlobItem(tr, s[i]);
                }
            } else {
                let value = htmlEncode(s[i]);
                tr.append(`<td><span title="${value}">${value}</span></td>`);
            }
        }
        tbody.append(tr);
    }
    sel.free();

    if (isEmptyTable) {
        infoBox.text("Keine Daten für diese Abfrage.");
        infoBox.show();
    }

    refreshPagination(query);

    // Enable tooltips
    document.querySelectorAll('[data-bs-toggle="tooltip"]')
        .forEach(tooltipTriggerEl => new bootstrap.Tooltip(tooltipTriggerEl));

    dataBox.editableTableWidget();
}

function renderBlobItem(tr, bytes) {
    const td = document.createElement("td");
    const span = document.createElement("span");
    span.title = "Blob";
    const downloadLink = document.createElement("a");
    downloadLink.href = "javascript:void(0)";
    downloadLink.innerText = `Herunterladen (${formatBytes(bytes.length)})`;
    downloadLink.onclick = function () {
        saveAs(new Blob([bytes]), "blob");
    };
    span.append(downloadLink);
    td.append(span);
    tr.append(td);
}

function formatBytes(bytes,decimals) {
    if(bytes === 0) return '0 Bytes';
    const k = 1024,
        dm = decimals || 2,
        sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
        i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        executeSql();
    }
}

function arrayToCsv(data) {
    return data.map(row =>
        row.map(String)  // convert every value to String
            .map(v => v.replaceAll('"', '""'))  // escape double quotes
            .map(v => `"${v}"`)  // quote it
            .join(',')  // comma-separated
    ).join('\r\n');  // rows starting on new lines
}

function exportCsvTableQuery(query) {
    let exportedRows = [];
    let sel = null;
    try {
        sel = db.prepare(query);
    } catch (ex) {
        if (sel != null) {
            sel.free();
        }
        showError(ex);
        setIsLoading(false);
        return null;
    }

    const columnNames = sel.getColumnNames();

    exportedRows.push(...[columnNames]);
    while (sel.step()) {
        const rows = sel.get();
        exportedRows.push(...[rows]);
    }
    sel.free();
    return exportedRows;
}

function exportCsvTable(tableName) {
    return exportCsvTableQuery(`SELECT * FROM '${tableName}'`);
}

function exportAllToCsv() {
    setIsLoading(true);
    const zip = new JSZip();
    for (const tableName of loadedTableNames) {
        const exportedRows = exportCsvTable(tableName);
        if (exportedRows != null) {
            zip.file(tableName + ".csv", arrayToCsv(exportedRows));
        } else {
            return;
        }
    }

    zip.generateAsync({type: "blob"})
        .then(function (content) {
            saveAs(content, "exported_all_db.zip");
        });
    setIsLoading(false);
}

function exportSelectedTableToCsv() {
    const tableName = $("#tables").val();
    setIsLoading(true);

    const exportedRows = exportCsvTable(tableName);
    if (exportedRows != null) {
        const blob = new Blob([arrayToCsv(exportedRows)], {type: "text/plain;charset=utf-8"});
        saveAs(blob, "exported_" + tableName.toLowerCase() + "_db.csv");
    }

    setIsLoading(false);
}

function exportQueryTableToCsv() {
    setIsLoading(true);

    const query = editor.getValue();
    const exportedRows = exportCsvTableQuery(query);
    if (exportedRows != null) {
        const blob = new Blob([arrayToCsv(exportedRows)], {type: "text/plain;charset=utf-8"});
        saveAs(blob, "exported_" + getTableNameFromQuery(query).toLowerCase() + "_db.csv");
    }

    setIsLoading(false);
}
