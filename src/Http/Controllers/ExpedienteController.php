<?php

namespace Muni\Arcop\Http\Controllers;

use Illuminate\Database\Eloquent\Model;
use Muni\Shared\Privacidad\Ciclo\EntregaDeCopia;
use Muni\Shared\Privacidad\Contratos\RegistroDeEvidencia;
use Muni\Shared\Privacidad\ExportacionDeDatos;
use Muni\Shared\Privacidad\Modelos\Solicitud;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * La descarga del expediente ARCOP.
 *
 * Por stream y nunca escrito en `public/`: es un documento con los datos
 * personales de un vecino, y un archivo dejado en el directorio público queda
 * accesible para cualquiera que adivine el nombre y, peor, indexable.
 *
 * La descarga queda registrada. Ese registro es de las dos partes: prueba que el
 * municipio le entregó lo que pidió, y deja anotado quién se llevó una copia de
 * los datos de esa persona.
 */
class ExpedienteController extends Controller
{
    public function descargar(Solicitud $solicitud, RegistroDeEvidencia $evidencia): StreamedResponse
    {
        $solicitud->loadMissing('titular');

        // Segunda guardia, a propósito. La vista ya oculta el botón cuando la
        // copia no procede, pero una URL se escribe a mano: sin esto, pedir el
        // expediente de una supresión devolvía un 500 con la traza a la vista en
        // vez de una negativa. El motivo es el del módulo, tal cual.
        $motivo = EntregaDeCopia::porQueNo($solicitud);

        if ($motivo !== null) {
            abort(403, $motivo);
        }

        // JSON_THROW_ON_ERROR, y ANTES de asentar la descarga: con un solo byte
        // inválido en un dato del vecino, json_encode() devolvía false, el
        // panel entregaba un archivo vacío con 200 y la bitácora ya había
        // certificado una entrega que no ocurrió. Ahora la excepción sube como
        // un 500 registrado y la bitácora no dice nada que no haya pasado.
        $contenido = json_encode(
            app(ExportacionDeDatos::class)->paraSolicitud($solicitud),
            JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR,
        );

        $evidencia->registrar('arcop.expediente.descargado', [
            'solicitud_id' => $solicitud->getKey(),
        ], $this->titularDe($solicitud));

        $nombre = 'expediente-arcop-'.$solicitud->getKey().'.json';

        return response()->streamDownload(function () use ($contenido): void {
            echo $contenido;
        }, $nombre, [
            'Content-Type' => 'application/json; charset=utf-8',
            // Un expediente con datos de un vecino no lo guarda ningún
            // intermediario ni queda en el historial del navegador compartido
            // de una oficina.
            'Cache-Control' => 'no-store, max-age=0',
        ]);
    }

    /**
     * El titular de la solicitud, sin pasar por la propiedad mágica de
     * Eloquent (`$solicitud->titular`): el modelo `Solicitud` vive en el
     * paquete compartido y no declara esa relación en su PHPDoc, así que
     * PHPStan no puede tipar el acceso mágico. Ya está cargada por el
     * `loadMissing()` de arriba, así que esto no agrega otra consulta.
     */
    private function titularDe(Solicitud $solicitud): ?Model
    {
        $titular = $solicitud->getRelation('titular');

        return $titular instanceof Model ? $titular : null;
    }
}
