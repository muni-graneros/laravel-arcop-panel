<?php

use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Storage;
use Muni\Arcop\AdoptanteIncompleto;
use Muni\Arcop\Permisos;
use Muni\Arcop\Tests\Fixtures\UsuarioDePrueba;
use Muni\Arcop\Tests\Fixtures\VecinoDePrueba;
use Muni\Shared\Privacidad\Modelos\Solicitud;

/*
 * `acreditacion_path` era una ruta del disco de evidencia tipeada por el
 * cliente en un <input type="text">, validada solo como string. Como el núcleo
 * BORRA ese documento al suprimir al titular, un funcionario con permiso de
 * recibir podía hacer que el módulo borrara el documento de OTRO vecino,
 * firmando el borrado como evidencia legal.
 *
 * Ahora el documento se sube y lo guarda el propio panel en el disco de
 * evidencia; la ruta nunca viene del cliente.
 */
beforeEach(function () {
    foreach (Permisos::todos() as $permiso) {
        Gate::define($permiso, fn (): bool => true);
    }

    $this->funcionario = UsuarioDePrueba::create(['name' => 'Ana Soto', 'email' => 'ana@ejemplo.cl']);

    $this->vecino = VecinoDePrueba::create([
        'nombre' => 'Rocío Paredes',
        'documento' => '11.111.111-1',
        'correo' => 'rocio@ejemplo.cl',
        'fecha_nacimiento' => now()->subYears(40)->toDateString(),
    ]);

    // El disco que el adoptante declaró al módulo: donde el núcleo va a buscar
    // los documentos para borrarlos al anonimizar.
    Storage::fake('evidencia');
    config(['privacidad.disco_evidencia' => 'evidencia']);

    $this->actingAs($this->funcionario);
});

it('una ruta tipeada por el cliente ya no se persiste como acreditación', function () {
    recibirSolicitud(['acreditacion_path' => 'privacidad/otro-vecino/cedula.pdf'])->assertRedirect();

    expect(Solicitud::sole()->acreditacion_path)->toBeNull();
});

it('el documento de representación se sube y lo guarda el panel bajo acreditaciones/, con nombre opaco', function () {
    recibirSolicitud([
        'solicitante' => 'apoderado',
        'acreditacion' => UploadedFile::fake()->create('poder-11111111-1.pdf', 40, 'application/pdf'),
    ])->assertRedirect();

    $ruta = (string) Solicitud::sole()->acreditacion_path;

    expect($ruta)->toStartWith('acreditaciones/')
        // El nombre original puede traer el RUT: no se conserva.
        ->and($ruta)->not->toContain('poder');

    Storage::disk('evidencia')->assertExists($ruta);
});

it('sin el documento, un apoderado no puede presentar la solicitud, y lo dice el módulo', function () {
    recibirSolicitud(['solicitante' => 'apoderado'])->assertSessionHasErrors('modulo');

    expect(Solicitud::count())->toBe(0);
});

it('si el módulo rechaza la solicitud, el documento subido no queda huérfano en el disco', function () {
    recibirSolicitud([
        'solicitante' => 'apoderado',
        'credencial' => '22.222.222-2',
        'acreditacion' => UploadedFile::fake()->create('poder.pdf', 40, 'application/pdf'),
    ])->assertSessionHasErrors('modulo');

    expect(Solicitud::count())->toBe(0)
        ->and(Storage::disk('evidencia')->allFiles())->toBe([]);
});

it('un archivo que no es PDF ni imagen se rechaza antes de tocar el disco', function () {
    recibirSolicitud([
        'solicitante' => 'apoderado',
        'acreditacion' => UploadedFile::fake()->create('macro.exe', 10, 'application/x-msdownload'),
    ])->assertSessionHasErrors('acreditacion');

    expect(Solicitud::count())->toBe(0)
        ->and(Storage::disk('evidencia')->allFiles())->toBe([]);
});

it('sin disco de evidencia declarado, el panel no guarda el documento en cualquier parte', function () {
    config(['privacidad.disco_evidencia' => null]);
    $this->withoutExceptionHandling();

    expect(fn () => recibirSolicitud([
        'solicitante' => 'apoderado',
        'acreditacion' => UploadedFile::fake()->create('poder.pdf', 40, 'application/pdf'),
    ]))->toThrow(AdoptanteIncompleto::class, 'disco');

    expect(Solicitud::count())->toBe(0);
});
