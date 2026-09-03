<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Índice sobre `datos->solicitud_id` para el expediente.
 *
 * `LineaDeTiempo::de()` filtra `privacidad_bitacora` —inmutable y solo
 * crece— por esa clave JSON en cada expediente abierto. Sin índice, cada
 * apertura de un caso escanea todas las filas del sistema. MariaDB no indexa
 * una expresión JSON directamente —a diferencia de MySQL 8—: hace falta una
 * columna generada (STORED, para que el índice no tenga que recalcular la
 * expresión en cada lectura) con el índice puesto sobre ELLA.
 *
 * Publicable y no automática a propósito: las migraciones de este ecosistema
 * no se aplican solas a producción. El adoptante la publica con
 * `php artisan vendor:publish --tag=arcop-panel-migrations`, revisa el SQL
 * con `--pretend` y la corre cuando le parezca. `LineaDeTiempo` sigue
 * funcionando igual —sin el índice— mientras la migración no se haya corrido.
 */
return new class extends Migration
{
    public function up(): void
    {
        // Solo MariaDB/MySQL: es la sintaxis de columna generada que soporta
        // este motor. El paquete no se instala sobre otro en producción; el
        // guard es para que la migración no reviente en la suite, que corre
        // contra SQLite en memoria (ver tests/IndiceLineaDeTiempoTest.php).
        if (! in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true)) {
            return;
        }

        Schema::table('privacidad_bitacora', function (Blueprint $table): void {
            $table->string('solicitud_ref', 191)
                ->storedAs("json_unquote(json_extract(datos, '$.solicitud_id'))")
                ->nullable()
                ->index();
        });
    }

    public function down(): void
    {
        if (! in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true)) {
            return;
        }

        Schema::table('privacidad_bitacora', function (Blueprint $table): void {
            $table->dropColumn('solicitud_ref');
        });
    }
};
