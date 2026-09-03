<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Schema;
use Muni\Arcop\Bitacora\LineaDeTiempo;
use Muni\Arcop\Permisos;
use Muni\Arcop\Tests\Fixtures\VecinoDePrueba;
use Muni\Shared\Privacidad\BaseLicitud;
use Muni\Shared\Privacidad\Modelos\Finalidad;
use Muni\Shared\Privacidad\ResultadoVerificacion;
use Muni\Shared\Privacidad\Solicitudes;
use Muni\Shared\Privacidad\TipoDeSolicitud;

/**
 * La migración del índice (database/migrations/…add_solicitud_ref…) es
 * publicable, no automática (ver ArcopPanelServiceProvider), y solo hace algo
 * en MariaDB/MySQL. La suite corre contra SQLite en memoria, así que estos
 * tests prueban dos cosas separadas: que correrla no rompe nada en un motor
 * sin soporte, y —solo si hay MariaDB/MySQL real disponible— que la línea de
 * tiempo usa la columna generada en vez de la clave JSON sin índice.
 */
function migracionDelIndice(): Migration
{
    return require __DIR__.'/../database/migrations/2026_09_03_000000_add_solicitud_ref_a_privacidad_bitacora.php';
}

beforeEach(function () {
    foreach (Permisos::todos() as $permiso) {
        Gate::define($permiso, fn (): bool => true);
    }

    Finalidad::create([
        'sistema' => 'atencionvecino', 'codigo' => 'requerimientos', 'nombre' => 'Requerimientos vecinales',
        'base_licitud' => BaseLicitud::FuncionLegal, 'norma_habilitante' => 'Ley 18.695',
    ]);
});

it('en un motor sin soporte de columnas generadas, correr la migración no cambia nada y la línea de tiempo sigue funcionando', function () {
    expect(Schema::hasColumn('privacidad_bitacora', 'solicitud_ref'))->toBeFalse();

    migracionDelIndice()->up();

    // SQLite no está en la lista de motores del guard: la migración no tocó
    // la tabla.
    expect(Schema::hasColumn('privacidad_bitacora', 'solicitud_ref'))->toBeFalse();

    $vecino = VecinoDePrueba::create([
        'nombre' => 'Iris Cortés', 'documento' => '9.999.999-9',
        'fecha_nacimiento' => now()->subYears(30)->toDateString(),
    ]);

    $solicitud = app(Solicitudes::class)->registrar(
        $vecino,
        TipoDeSolicitud::Acceso,
        'Quiero saber qué datos tienen de mí.',
        new ResultadoVerificacion(true, 'cedula_presencial', []),
    );

    $linea = app(LineaDeTiempo::class)->de($solicitud);

    expect($linea)->toHaveCount(1)
        ->and($linea->first()->evento)->toBe('solicitud.registrada');

    migracionDelIndice()->down();
});

it('cuando la columna solicitud_ref existe, la línea de tiempo filtra por ella y no por la clave JSON', function () {
    // No hace falta MariaDB para probar la RAMA de la consulta: basta con que
    // la columna exista. Acá se agrega una columna plana (no generada) en
    // SQLite, con un valor deliberadamente distinto del id real: si
    // LineaDeTiempo siguiera mirando `datos->solicitud_id`, la entrada
    // aparecería igual; si ya prefiere `solicitud_ref`, deja de aparecer.
    Schema::table('privacidad_bitacora', function (Blueprint $table): void {
        $table->string('solicitud_ref')->nullable();
    });

    $vecino = VecinoDePrueba::create([
        'nombre' => 'Iris Cortés', 'documento' => '9.999.999-9',
        'fecha_nacimiento' => now()->subYears(30)->toDateString(),
    ]);

    $solicitud = app(Solicitudes::class)->registrar(
        $vecino,
        TipoDeSolicitud::Acceso,
        'Quiero saber qué datos tienen de mí.',
        new ResultadoVerificacion(true, 'cedula_presencial', []),
    );

    DB::table('privacidad_bitacora')->update(['solicitud_ref' => 'no-es-el-id-real']);

    expect(app(LineaDeTiempo::class)->de($solicitud))->toHaveCount(0);

    Schema::table('privacidad_bitacora', function (Blueprint $table): void {
        $table->dropColumn('solicitud_ref');
    });
});

it('con MariaDB/MySQL real, la columna generada queda indexada y la línea de tiempo la usa', function () {
    if (! in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true)) {
        $this->markTestSkipped(
            'Necesita MariaDB/MySQL real: SQLite no soporta json_unquote()/json_extract() como columna '
            .'generada con esta sintaxis. Sin Docker/MariaDB disponible en este entorno, este test queda '
            .'sin ejercitar — ver el resumen de la tarea.',
        );
    }

    migracionDelIndice()->up();

    expect(Schema::hasColumn('privacidad_bitacora', 'solicitud_ref'))->toBeTrue();

    $vecino = VecinoDePrueba::create([
        'nombre' => 'Iris Cortés', 'documento' => '9.999.999-9',
        'fecha_nacimiento' => now()->subYears(30)->toDateString(),
    ]);

    $solicitud = app(Solicitudes::class)->registrar(
        $vecino,
        TipoDeSolicitud::Acceso,
        'Quiero saber qué datos tienen de mí.',
        new ResultadoVerificacion(true, 'cedula_presencial', []),
    );

    $linea = app(LineaDeTiempo::class)->de($solicitud);

    expect($linea)->toHaveCount(1);

    migracionDelIndice()->down();
});
